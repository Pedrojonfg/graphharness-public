// Ported from the GraphLearn web app (65b56d6; see docs/PROVENANCE.md). Simplified: a single use
// (MapPage), nodes colored by state and a dashed outline if the declaration is `pending`.
import "@xyflow/react/dist/style.css";
import type { MapConcept, SubjectMap } from "@graphharness/contracts";
import { Background, Controls, type Edge, Handle, MarkerType, type Node, type NodeProps, Position, ReactFlow } from "@xyflow/react";
import { useMemo } from "react";
import { STATE_LABEL } from "../components/Ui.tsx";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, relations } from "./graph.ts";

type ConceptData = { c: MapConcept; dimmed: boolean };
type ConceptNode = Node<ConceptData, "concept">;

function label(c: MapConcept): string {
  return `${c.name}, ${STATE_LABEL[c.state]}${c.manualConfirmation === "pending" ? ", unconfirmed declaration" : ""}${c.stale ? ", no recent evidence" : ""}`;
}

function Concept({ data, selected }: NodeProps<ConceptNode>) {
  const { c, dimmed } = data;
  const cls = ["node", `node-${c.state}`, c.manualConfirmation === "pending" && "node-pending", selected && "node-sel", dimmed && "node-dim"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} style={{ width: NODE_WIDTH, height: NODE_HEIGHT }} title={label(c)}>
      <Handle type="target" position={Position.Top} className="node-handle" />
      <span className="node-name">{c.name}</span>
      <Handle type="source" position={Position.Bottom} className="node-handle" />
    </div>
  );
}

const nodeTypes = { concept: Concept };

export function GraphCanvas({ map, focusId, onNodeClick }: { map: SubjectMap; focusId: string | null; onNodeClick: (id: string) => void }) {
  const positions = useMemo(() => layoutGraph(map), [map]);

  const related = useMemo(() => {
    if (!focusId) return null;
    const { before, unlocks } = relations(map, focusId);
    return new Set([focusId, ...before.map((n) => n.id), ...unlocks.map((n) => n.id)]);
  }, [map, focusId]);

  const nodes = useMemo<ConceptNode[]>(
    () =>
      map.concepts.map((c) => ({
        id: c.id,
        type: "concept",
        position: positions.get(c.id)!,
        data: { c, dimmed: related !== null && !related.has(c.id) },
        selected: c.id === focusId,
        draggable: false,
        connectable: false,
        ariaLabel: label(c),
      })),
    [map, positions, related, focusId],
  );

  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(map.concepts.map((c) => c.id));
    return map.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => {
        const touches = focusId !== null && (e.from === focusId || e.to === focusId);
        return {
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          className: ["edge", e.relation === "illustrates" && "edge-illustrates", e.confidence === "low" && "edge-low", touches && "edge-sel", focusId && !touches && "edge-dim"]
            .filter(Boolean)
            .join(" "),
          focusable: false,
        };
      });
  }, [map, focusId]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onNodeClick(n.id)}
      nodesFocusable
      nodesDraggable={false}
      nodesConnectable={false}
      fitView
      fitViewOptions={{ padding: 0.12, minZoom: 0.5, maxZoom: 1 }}
      minZoom={0.2}
      colorMode="system"
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
