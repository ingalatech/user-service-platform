import { useState, type ReactNode } from 'react';
import { useNotify } from 'ra-core';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../kit/components/ui/dialog.js';
import { Button } from '../kit/components/ui/button.js';

export function PrototypeConfirmAction({
  label,
  title,
  description,
  confirmLabel = 'Confirmar',
  onConfirm,
  children,
}: {
  label: string;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm?: () => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const notify = useNotify();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" aria-label={label} />}>
        {label}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancelar</DialogClose>
          <Button
            onClick={() => {
              onConfirm?.();
              notify('Acción simulada en este prototipo.', { type: 'success' });
              setOpen(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
