import { useEffect, useRef, type RefObject } from 'react'

/** Keeps a native dialog's imperative state aligned with React state. */
export function useDialog(open: boolean): RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return ref
}
