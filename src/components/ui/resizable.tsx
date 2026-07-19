"use client";

import * as React from "react";
import { GripVerticalIcon } from "lucide-react";
import {
  PanelGroup as ResizablePrimitivePanelGroup,
  Panel as ResizablePrimitivePanel,
  PanelResizeHandle as ResizablePrimitivePanelResizeHandle,
  disableGlobalCursorStyles,
} from "react-resizable-panels";

import { cn } from "./utils";

// Library injects `*{cursor: ew-resize !important}` (and e/w/move variants) while the
// pointer is within hit-area margins. That makes the cursor flip twice when crossing a
// separator. We use a real hit box + CSS cursor instead.
disableGlobalCursorStyles();

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitivePanelGroup>) {
  return (
    <ResizablePrimitivePanelGroup
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({
  ...props
}: React.ComponentProps<typeof ResizablePrimitivePanel>) {
  return <ResizablePrimitivePanel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitivePanelResizeHandle> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitivePanelResizeHandle
      data-slot="resizable-handle"
      // No invisible hover band outside the handle: default fine margin is 5px and
      // causes cursor change before the pointer reaches the visible line.
      hitAreaMargins={{ fine: 0, coarse: 4 }}
      className={cn(
        // Physical hit box = cursor zone (one change only). Paint a 1px rule in the center.
        "relative z-10 flex shrink-0 items-center justify-center outline-hidden",
        "bg-transparent",
        // Horizontal panel groups → vertical separator
        "w-1.5 cursor-col-resize",
        "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2",
        "before:w-px before:-translate-x-1/2 before:bg-border before:transition-colors before:duration-150",
        "hover:before:bg-primary active:before:bg-primary",
        "data-[resize-handle-state=drag]:before:bg-primary",
        "focus-visible:before:bg-primary",
        // Vertical panel groups → horizontal separator
        "data-[panel-group-direction=vertical]:h-1.5 data-[panel-group-direction=vertical]:w-full",
        "data-[panel-group-direction=vertical]:cursor-row-resize",
        "data-[panel-group-direction=vertical]:before:inset-x-0 data-[panel-group-direction=vertical]:before:inset-y-auto",
        "data-[panel-group-direction=vertical]:before:top-1/2 data-[panel-group-direction=vertical]:before:left-0",
        "data-[panel-group-direction=vertical]:before:h-px data-[panel-group-direction=vertical]:before:w-full",
        "data-[panel-group-direction=vertical]:before:-translate-y-1/2 data-[panel-group-direction=vertical]:before:translate-x-0",
        "[&[data-panel-group-direction=vertical]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitivePanelResizeHandle>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
