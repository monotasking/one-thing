import {
  FolderTree,
  GitCompare,
  Terminal,
  Globe,
  Settings,
  LayoutGrid,
  Plus,
  X,
  Pin,
  PictureInPicture2,
  Maximize2,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  ChevronsLeft,
  ChevronsUp,
  ChevronsDown,
  Search,
  Check,
  Eye,
  Minus,
  Info,
  CircleCheck,
  CircleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * item 只写图标「名字」(一个字符串),不许直接持有组件 ——
 * 这样 items 表将来可以来自 JSON / 后端而不牵动渲染层。
 */
const REGISTRY: Record<string, LucideIcon> = {
  FolderTree,
  GitCompare,
  Terminal,
  Globe,
  Settings,
  LayoutGrid,
  Plus,
  X,
  Pin,
  PictureInPicture2,
  Maximize2,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  ChevronsLeft,
  ChevronsUp,
  ChevronsDown,
  Search,
  Check,
  Eye,
  Minus,
  Info,
  CircleCheck,
  CircleAlert,
}

export function resolveIcon(name: string): LucideIcon {
  return REGISTRY[name] ?? FolderTree
}

export {
  Plus,
  X,
  Pin,
  PictureInPicture2,
  Maximize2,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  ChevronsLeft,
  ChevronsUp,
  ChevronsDown,
  Search,
  Check,
  Eye,
  Minus,
  Info,
  CircleCheck,
  CircleAlert,
}
export type { LucideIcon }
