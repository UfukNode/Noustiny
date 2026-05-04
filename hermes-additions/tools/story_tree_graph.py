#!/usr/bin/env python3
"""
Story Tree Graph Tool — deterministic graph operations on a narrative tree.

LLMs are unreliable at tree traversal (ancestor walks, canon-path resolution,
sibling enumeration) because they rely on surface-level pattern matching over
node IDs. This tool exposes those operations as pure Python primitives so
narrative agents can reason about beat structure without hallucinating
relationships.

Design notes:

- Input is the full tree snapshot (list of nodes). Requests are single-shot
  queries; no persistent state lives here. This keeps the tool safe to call
  concurrently and easy to reason about.
- Operations are deliberately narrow. Anything that requires LLM judgement
  (ordering scenes into acts, picking a canonical branch among siblings) is
  left to the narrative-* skills. This tool only answers structural questions.
- Canon path is resolved by following each node's ``canonChildId`` pointer
  from the root down — the narrative graph model enforces a single canon
  spine, so there is never ambiguity. If a node has no ``canonChildId``, the
  spine stops there even if visited descendants exist.
- Validation is intentionally forgiving: we flag broken pointers but never
  raise, so a mid-edit client can still query partial trees.

Input shape (``tree``):

    {
      "rootId": "n0",
      "nodes": [
        {
          "id": "n0",
          "parentId": null,
          "canonChildId": "n1",
          "title": "...",
          "mood": "hopeful",
          "actNumber": 1,
          "depth": 0,
          "sceneId": "s0"
        },
        ...
      ]
    }

All node fields except ``id`` are optional from the graph's perspective.
Narrative skills decide which fields they care about.
"""

import json
import logging
from typing import Any, Dict, List, Optional, Set

from tools.registry import registry

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _index_nodes(tree: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Build {id: node} from the tree's node list. Silently skips entries
    missing an id so partial trees from mid-edit clients still work."""
    by_id: Dict[str, Dict[str, Any]] = {}
    for node in tree.get("nodes") or []:
        nid = node.get("id")
        if isinstance(nid, str) and nid:
            by_id[nid] = node
    return by_id


def _resolve_root_id(tree: Dict[str, Any], by_id: Dict[str, Dict[str, Any]]) -> Optional[str]:
    """Prefer explicit rootId, fall back to the single parentless node."""
    declared = tree.get("rootId")
    if isinstance(declared, str) and declared in by_id:
        return declared
    parentless = [nid for nid, n in by_id.items() if not n.get("parentId")]
    if len(parentless) == 1:
        return parentless[0]
    return None


def _children_index(by_id: Dict[str, Dict[str, Any]]) -> Dict[str, List[str]]:
    """Reverse-index parentId → [child ids] in insertion order."""
    children: Dict[str, List[str]] = {}
    for nid, node in by_id.items():
        pid = node.get("parentId")
        if isinstance(pid, str) and pid:
            children.setdefault(pid, []).append(nid)
    return children


# ---------------------------------------------------------------------------
# Operation handlers
# ---------------------------------------------------------------------------

def _op_canon_path(by_id: Dict[str, Dict[str, Any]], root_id: str) -> List[str]:
    """Walk canonChildId from root until the spine terminates."""
    path: List[str] = []
    cursor: Optional[str] = root_id
    seen: Set[str] = set()
    while cursor and cursor in by_id and cursor not in seen:
        path.append(cursor)
        seen.add(cursor)
        cursor = by_id[cursor].get("canonChildId")
        if not isinstance(cursor, str):
            break
    return path


def _op_ancestors(by_id: Dict[str, Dict[str, Any]], node_id: str) -> List[str]:
    """Walk parentId upward. Excludes the node itself. Root first, target last's parent."""
    chain: List[str] = []
    seen: Set[str] = set()
    cursor = by_id.get(node_id, {}).get("parentId")
    while isinstance(cursor, str) and cursor in by_id and cursor not in seen:
        chain.append(cursor)
        seen.add(cursor)
        cursor = by_id[cursor].get("parentId")
    return list(reversed(chain))


def _op_descendants(
    by_id: Dict[str, Dict[str, Any]],
    children: Dict[str, List[str]],
    node_id: str,
    depth_limit: Optional[int],
) -> List[str]:
    """BFS from node_id. Excludes node_id itself. Respects depth_limit when set."""
    if node_id not in by_id:
        return []
    out: List[str] = []
    frontier: List[tuple[str, int]] = [(node_id, 0)]
    seen: Set[str] = {node_id}
    while frontier:
        nid, depth = frontier.pop(0)
        if depth_limit is not None and depth >= depth_limit:
            continue
        for child in children.get(nid, []):
            if child in seen:
                continue
            seen.add(child)
            out.append(child)
            frontier.append((child, depth + 1))
    return out


def _op_siblings(
    by_id: Dict[str, Dict[str, Any]],
    children: Dict[str, List[str]],
    node_id: str,
) -> List[str]:
    """All children of the node's parent, excluding the node itself."""
    node = by_id.get(node_id)
    if not node:
        return []
    pid = node.get("parentId")
    if not isinstance(pid, str):
        return []
    return [c for c in children.get(pid, []) if c != node_id]


def _op_scene_members(
    by_id: Dict[str, Dict[str, Any]],
    node_id: str,
) -> List[str]:
    """All node ids that share sceneId with node_id. Order follows input order."""
    node = by_id.get(node_id)
    if not node:
        return []
    target_scene = node.get("sceneId")
    if not isinstance(target_scene, str) or not target_scene:
        return [node_id]
    return [nid for nid, n in by_id.items() if n.get("sceneId") == target_scene]


def _op_validate(
    by_id: Dict[str, Dict[str, Any]],
    children: Dict[str, List[str]],
    root_id: Optional[str],
) -> Dict[str, Any]:
    """Return a diagnostic report. Never raises."""
    issues: List[Dict[str, str]] = []

    if root_id is None:
        issues.append({"code": "no_root", "detail": "tree.rootId missing and cannot be inferred"})

    for nid, node in by_id.items():
        pid = node.get("parentId")
        if isinstance(pid, str) and pid and pid not in by_id:
            issues.append({"code": "dangling_parent", "node": nid, "parent": pid})
        canon = node.get("canonChildId")
        if isinstance(canon, str) and canon and canon not in by_id:
            issues.append({"code": "dangling_canon", "node": nid, "canon": canon})
        if isinstance(canon, str) and canon and canon in by_id:
            child_parent = by_id[canon].get("parentId")
            if child_parent != nid:
                issues.append({
                    "code": "canon_not_child",
                    "node": nid,
                    "canon": canon,
                    "actual_parent": child_parent,
                })

    # Unreachable nodes: those not descended from root.
    reachable: Set[str] = set()
    if root_id is not None and root_id in by_id:
        reachable.add(root_id)
        stack = [root_id]
        while stack:
            cur = stack.pop()
            for c in children.get(cur, []):
                if c not in reachable:
                    reachable.add(c)
                    stack.append(c)
    for nid in by_id:
        if nid not in reachable:
            issues.append({"code": "unreachable", "node": nid})

    return {
        "ok": not issues,
        "node_count": len(by_id),
        "root_id": root_id,
        "issues": issues,
    }


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

_REQUIRES_NODE_ID = {"ancestors", "descendants", "siblings", "scene_members"}


def _handle_story_tree_graph(args: Dict[str, Any]) -> str:
    op = (args.get("operation") or "").strip().lower()
    tree = args.get("tree")
    if not isinstance(tree, dict):
        return json.dumps({"error": "tree must be an object with at least a 'nodes' array."})

    by_id = _index_nodes(tree)
    if not by_id:
        return json.dumps({"error": "tree.nodes is empty or missing."})

    children = _children_index(by_id)
    root_id = _resolve_root_id(tree, by_id)

    node_id = args.get("node_id")
    if op in _REQUIRES_NODE_ID:
        if not isinstance(node_id, str) or node_id not in by_id:
            return json.dumps({
                "error": f"operation '{op}' requires a valid 'node_id' present in tree.nodes."
            })

    depth_limit = args.get("depth_limit")
    if depth_limit is not None:
        try:
            depth_limit = int(depth_limit)
            if depth_limit < 1:
                depth_limit = None
        except (TypeError, ValueError):
            depth_limit = None

    try:
        if op == "canon_path":
            if root_id is None:
                return json.dumps({"error": "canon_path requires a resolvable root."})
            return json.dumps({"operation": op, "path": _op_canon_path(by_id, root_id)})

        if op == "ancestors":
            return json.dumps({"operation": op, "node_id": node_id,
                               "ancestors": _op_ancestors(by_id, node_id)})

        if op == "descendants":
            return json.dumps({
                "operation": op, "node_id": node_id, "depth_limit": depth_limit,
                "descendants": _op_descendants(by_id, children, node_id, depth_limit),
            })

        if op == "siblings":
            return json.dumps({"operation": op, "node_id": node_id,
                               "siblings": _op_siblings(by_id, children, node_id)})

        if op == "scene_members":
            return json.dumps({"operation": op, "node_id": node_id,
                               "members": _op_scene_members(by_id, node_id)})

        if op == "validate":
            return json.dumps({"operation": op, **_op_validate(by_id, children, root_id)})

        return json.dumps({
            "error": f"unknown operation '{op}'. "
                     "Expected one of: canon_path, ancestors, descendants, siblings, scene_members, validate."
        })
    except Exception as exc:
        logger.exception("story_tree_graph handler failed")
        return json.dumps({"error": f"internal error during '{op}': {exc}"})


def check_story_tree_graph_requirements() -> bool:
    """Pure Python, stdlib only — always available."""
    return True


# ---------------------------------------------------------------------------
# OpenAI Function-Calling Schema
# ---------------------------------------------------------------------------

STORY_TREE_GRAPH_SCHEMA = {
    "name": "story_tree_graph",
    "description": (
        "Deterministic graph operations on a narrative story tree. Use this tool "
        "when you need an exact answer to a structural question about the tree — "
        "canon path, ancestors of a node, descendants within N levels, siblings "
        "of a node, members of a scene, or a validation sweep. "
        "This tool never makes creative judgements; it only walks pointers. "
        "\n\n"
        "Pass the full tree snapshot every call. No state is persisted between "
        "invocations. For creative operations (picking which branch to canonise, "
        "grouping nodes into scenes, rendering prose) use the narrative-* skills "
        "instead — those are LLM reasoning tasks, not graph walks."
    ),
    "parameters": {
        "type": "object",
        "required": ["operation", "tree"],
        "properties": {
            "operation": {
                "type": "string",
                "enum": [
                    "canon_path",
                    "ancestors",
                    "descendants",
                    "siblings",
                    "scene_members",
                    "validate",
                ],
                "description": (
                    "canon_path: walk canonChildId from root to tip. "
                    "ancestors: parent chain up to root, excluding node itself. "
                    "descendants: BFS of all nodes under node_id, bounded by depth_limit. "
                    "siblings: same-parent nodes excluding node_id itself. "
                    "scene_members: all nodes sharing node_id's sceneId. "
                    "validate: return structural diagnostics for the whole tree."
                ),
            },
            "tree": {
                "type": "object",
                "description": (
                    "The full narrative tree. Must contain a 'nodes' array; "
                    "each node must have an 'id' and may have parentId, canonChildId, "
                    "sceneId, actNumber, mood, tone, title, body, depth. "
                    "Optionally include 'rootId'; otherwise the unique parentless "
                    "node is inferred."
                ),
                "properties": {
                    "rootId": {"type": "string"},
                    "nodes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["id"],
                            "properties": {
                                "id": {"type": "string"},
                                "parentId": {"type": ["string", "null"]},
                                "canonChildId": {"type": ["string", "null"]},
                                "sceneId": {"type": ["string", "null"]},
                                "actNumber": {"type": ["integer", "null"]},
                                "mood": {"type": ["string", "null"]},
                                "tone": {"type": ["string", "null"]},
                                "title": {"type": ["string", "null"]},
                                "body": {"type": ["string", "null"]},
                                "depth": {"type": ["integer", "null"]},
                            },
                        },
                    },
                },
                "required": ["nodes"],
            },
            "node_id": {
                "type": "string",
                "description": (
                    "Target node id. Required for ancestors, descendants, siblings, "
                    "scene_members. Ignored for canon_path and validate."
                ),
            },
            "depth_limit": {
                "type": "integer",
                "description": (
                    "Only used with descendants. Caps BFS depth. Minimum 1; "
                    "omit for unlimited."
                ),
            },
        },
    },
}


registry.register(
    name="story_tree_graph",
    toolset="narrative",
    schema=STORY_TREE_GRAPH_SCHEMA,
    handler=_handle_story_tree_graph,
    check_fn=check_story_tree_graph_requirements,
    requires_env=[],
    is_async=False,
    emoji="🌳",
)
