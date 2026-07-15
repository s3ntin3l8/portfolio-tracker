"use client";

import { GripVertical } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/**
 * Drag-sortable `<tr>` wrapper. Render-prop receives a scoped handle `<button>`.
 * Desktop uses this; mobile sortable cards use `SortableCard` instead.
 */
export function SortableRow({
  id,
  dragHandleLabel,
  children,
}: {
  id: string;
  dragHandleLabel: string;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label={dragHandleLabel}
      className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
    >
      <GripVertical className="size-4" />
    </button>
  );

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={`border-b border-border last:border-0${isDragging ? " opacity-50" : ""}`}
    >
      {children(handle)}
    </tr>
  );
}

/**
 * Drag-sortable `<div>` card for mobile (iOS reorder mode).
 * Render-prop receives a scoped handle `<button>` — the card body itself is not a
 * drag surface so vertical scrolling works normally.
 * `disabled` gates `useSortable` registration so cards outside reorder mode don't
 * participate in drag-and-drop at all.
 */
export function SortableCard({
  id,
  disabled,
  dragHandleLabel,
  children,
}: {
  id: string;
  disabled: boolean;
  dragHandleLabel: string;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label={dragHandleLabel}
      className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
    >
      <GripVertical className="size-5" />
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-[14px] border border-border bg-card p-3.5${isDragging ? " opacity-50" : ""}`}
    >
      {children(handle)}
    </div>
  );
}
