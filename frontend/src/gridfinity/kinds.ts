// The three kinds of Gridfinity project, with the icon each is shown with.
import { Box, Grid3x3, LayoutGrid } from 'lucide-react'
import type { ProjectMode } from './types'

export const KIND: Record<ProjectMode, { label: string; icon: typeof Box }> = {
  project: { label: 'Drawer project', icon: LayoutGrid },
  bin: { label: 'Single bin', icon: Box },
  plate: { label: 'Single baseplate', icon: Grid3x3 },
}
