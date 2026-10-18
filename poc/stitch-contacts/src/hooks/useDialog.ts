import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

export function useDialog(open: boolean): RefObject<HTMLDialogElement | null> {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
      restoreFocusRef.current?.focus()
      restoreFocusRef.current = null
    }

    return () => {
      if (dialog.open) dialog.close()
      restoreFocusRef.current?.focus()
      restoreFocusRef.current = null
    }
  }, [open])

  return dialogRef
}
