import React, { useState, useCallback } from 'react'
import {
  LayoutDashboard,
  Search,
  Plus,
  Settings,
  ChevronRight,
  Terminal,
  Zap,
  Trash2
} from 'lucide-react'
import { cn, getProjectInitials } from '../../lib/utils'
import { useAppStore, selectFilteredTasks } from '../../stores/appStore'
import { STATUS_CONFIG } from '../../types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ContextMenu, type ContextMenuState } from '../ui/context-menu'

const isElectron = typeof window !== 'undefined' && !!window.api

interface SidebarProps {
  className?: string
}

export function Sidebar({ className }: SidebarProps) {
  const {
    projects,
    selectedTaskId,
    selectedProjectId,
    searchQuery,
    selectTask,
    setProjectFilter,
    setSearch,
    openCreateModal,
    openSettings,
    deleteTask,
    deleteProject
  } = useAppStore()

  const tasks = useAppStore(selectFilteredTasks)
  const allTasks = useAppStore((s) => s.tasks)
  const runningCount = allTasks.filter((t) => t.status === 'running').length
  const waitingCount = allTasks.filter((t) => t.status === 'waiting').length

  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [ctxMenu, setCtxMenu] = useState<(ContextMenuState & { taskId: string }) | null>(null)
  const [projectCtxMenu, setProjectCtxMenu] = useState<(ContextMenuState & { projectId: string }) | null>(null)

  const handleTaskContextMenu = useCallback((e: React.MouseEvent, taskId: string) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, taskId })
  }, [])

  const handleProjectContextMenu = useCallback((e: React.MouseEvent, projectId: string) => {
    e.preventDefault()
    setProjectCtxMenu({ x: e.clientX, y: e.clientY, projectId })
  }, [])

  const handleDeleteTask = useCallback(async (taskId: string) => {
    if (isElectron) {
      await window.api.tasks.delete(taskId)
    }
    deleteTask(taskId)
  }, [deleteTask])

  const handleDeleteProject = useCallback(async (projectId: string) => {
    if (isElectron) {
      await window.api.projects.delete(projectId)
    }
    deleteProject(projectId)
  }, [deleteProject])

  return (
    <aside
      className={cn(
        'flex flex-col h-full bg-[#0d0d0d] border-r border-white/[0.06] w-60 shrink-0',
        className
      )}
    >
      {/* App header / title bar drag area */}
      <div
        className={cn(
          'flex items-center gap-2.5 px-4 pb-4 app-drag-region',
          // Leave room for the native traffic lights (trafficLightPosition in main/index.ts)
          window.api?.platform === 'darwin' ? 'pt-12' : 'pt-5'
        )}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
          <Zap className="w-3.5 h-3.5 text-white" />
        </div>
        <span className="font-semibold text-sm text-zinc-100 tracking-tight">Relay Flowstate</span>
        {(runningCount > 0 || waitingCount > 0) && (
          <div className="ml-auto flex items-center gap-1">
            {runningCount > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            )}
            {waitingCount > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            )}
          </div>
        )}
      </div>

      {/* New task button */}
      <div className="px-3 mb-3">
        <Button
          variant="primary"
          size="sm"
          className="w-full gap-1.5 h-8 text-xs"
          onClick={openCreateModal}
        >
          <Plus className="w-3.5 h-3.5" />
          New Task
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 mb-4">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
          <Input
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs bg-white/[0.02] border-white/[0.06]"
          />
        </div>
      </div>

      {/* Nav items */}
      <nav className="px-2 mb-4 space-y-0.5">
        <SidebarNavItem
          icon={<LayoutDashboard className="w-4 h-4" />}
          label="All Tasks"
          active={!selectedTaskId && !selectedProjectId}
          onClick={() => { selectTask(null); setProjectFilter(null) }}
          badge={allTasks.length > 0 ? allTasks.length : undefined}
        />
        <SidebarNavItem
          icon={<Terminal className="w-4 h-4" />}
          label="Running"
          onClick={() => { selectTask(null); setProjectFilter(null) }}
          badge={runningCount > 0 ? runningCount : undefined}
          badgeColor="emerald"
        />
      </nav>

      <div className="px-3 mb-2">
        <div className="h-px bg-white/[0.05]" />
      </div>

      {/* Projects */}
      <div className="px-2 mb-1">
        <button
          className="flex items-center gap-1 w-full px-2 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-400 transition-colors"
          onClick={() => setProjectsExpanded(!projectsExpanded)}
        >
          <ChevronRight
            className={cn(
              'w-3 h-3 transition-transform duration-150',
              projectsExpanded && 'rotate-90'
            )}
          />
          Projects
          <span className="ml-auto text-zinc-600">{projects.length}</span>
        </button>
      </div>

      {projectsExpanded && (
        <div className="px-2 space-y-0.5 mb-4">
          {projects.map((project) => {
            const isActive = selectedProjectId === project.id
            const projectTaskCount = allTasks.filter((t) => t.project_id === project.id).length
            return (
              <button
                key={project.id}
                className={cn(
                  'flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md transition-all duration-100 text-left group',
                  isActive
                    ? 'bg-white/[0.07] text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
                )}
                onClick={() => setProjectFilter(isActive ? null : project.id)}
                onContextMenu={(e) => handleProjectContextMenu(e, project.id)}
              >
                <div className={cn(
                  'w-5 h-5 rounded border flex items-center justify-center text-[9px] font-bold shrink-0 transition-colors',
                  isActive
                    ? 'bg-blue-600/20 border-blue-500/40 text-blue-400'
                    : 'bg-zinc-800 border-white/[0.06] text-zinc-400 group-hover:border-white/10'
                )}>
                  {getProjectInitials(project.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{project.name}</div>
                </div>
                {projectTaskCount > 0 && (
                  <span className="text-[10px] text-zinc-600 shrink-0">{projectTaskCount}</span>
                )}
              </button>
            )
          })}
          <button
            className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.03] transition-all duration-100"
            onClick={openCreateModal}
          >
            <div className="w-5 h-5 rounded border border-dashed border-zinc-700 flex items-center justify-center shrink-0">
              <Plus className="w-2.5 h-2.5" />
            </div>
            <span className="text-xs">New Project</span>
          </button>
        </div>
      )}

      <div className="px-3 mb-2">
        <div className="h-px bg-white/[0.05]" />
      </div>

      {/* Recent tasks */}
      <div className="px-2 mb-1">
        <span className="flex items-center gap-1 w-full px-2 py-1 text-xs font-medium text-zinc-500">
          Recent Tasks
        </span>
      </div>
      <div className="px-2 space-y-0.5 flex-1 overflow-y-auto">
        {tasks.map((task) => {
          const statusCfg = STATUS_CONFIG[task.status]
          return (
            <button
              key={task.id}
              onClick={() => selectTask(task.id)}
              onContextMenu={(e) => handleTaskContextMenu(e, task.id)}
              className={cn(
                'flex items-start gap-2 w-full px-2 py-2 rounded-md text-left transition-all duration-100',
                selectedTaskId === task.id
                  ? 'bg-white/[0.07] text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
              )}
            >
              <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0', statusCfg.dot)} />
              <div className="min-w-0">
                <div className="text-xs font-medium leading-snug truncate">{task.title}</div>
                <div className="text-[10px] text-zinc-600 mt-0.5 truncate">{task.project_name}</div>
              </div>
            </button>
          )
        })}
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              label: 'Delete Task',
              icon: <Trash2 className="w-3.5 h-3.5" />,
              variant: 'danger',
              onClick: () => handleDeleteTask(ctxMenu.taskId)
            }
          ]}
        />
      )}
      {projectCtxMenu && (
        <ContextMenu
          x={projectCtxMenu.x}
          y={projectCtxMenu.y}
          onClose={() => setProjectCtxMenu(null)}
          items={[
            {
              label: 'Delete Project',
              icon: <Trash2 className="w-3.5 h-3.5" />,
              variant: 'danger',
              onClick: () => handleDeleteProject(projectCtxMenu.projectId)
            }
          ]}
        />
      )}

      {/* Bottom settings */}
      <div className="mt-auto px-3 pb-4 pt-3 border-t border-white/[0.05]">
        <button
          onClick={openSettings}
          className="flex items-center gap-2.5 w-full px-2 py-2 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-all duration-100"
        >
          <Settings className="w-4 h-4" />
          <span className="text-xs">Settings</span>
        </button>
      </div>
    </aside>
  )
}

interface SidebarNavItemProps {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
  badge?: number
  badgeColor?: 'emerald' | 'amber' | 'default'
}

function SidebarNavItem({
  icon,
  label,
  active,
  onClick,
  badge,
  badgeColor = 'default'
}: SidebarNavItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 w-full px-2 py-2 rounded-md text-sm transition-all duration-100',
        active
          ? 'bg-white/[0.07] text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]'
      )}
    >
      <span className={cn(active ? 'text-zinc-200' : 'text-zinc-500')}>{icon}</span>
      <span className="text-xs font-medium">{label}</span>
      {badge !== undefined && (
        <span
          className={cn(
            'ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-md',
            badgeColor === 'emerald'
              ? 'bg-emerald-400/15 text-emerald-400'
              : badgeColor === 'amber'
                ? 'bg-amber-400/15 text-amber-400'
                : 'bg-zinc-800 text-zinc-400'
          )}
        >
          {badge}
        </span>
      )}
    </button>
  )
}
