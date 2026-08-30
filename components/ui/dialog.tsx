"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPrimitive.Portal>
    {/*
      The overlay sits strictly below the content. Both were z-50, which left
      their order to DOM position - fragile, because `backdrop-blur` creates
      its own stacking context and could paint the blur over the dialog.
      An explicit two-level split removes the ambiguity.
    */}
    <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[2px] data-[state=open]:animate-fade-up" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 w-[min(94vw,560px)] -translate-x-1/2 -translate-y-1/2",
        // Never inherit a blur from the backdrop: the dialog is the one thing
        // on screen that must stay legible.
        "backdrop-blur-none",
        "surface bg-surface p-5 shadow-2xl data-[state=open]:animate-fade-up",
        "max-h-[88vh] overflow-y-auto",
        className,
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-muted transition-colors hover:bg-elevated hover:text-ink focus-ring">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";
