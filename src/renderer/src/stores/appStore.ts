import { create } from 'zustand'
import type { Task, Project, AgentDescriptor } from '../types'
import { PROCESS_LABELS, PROCESS_COLORS } from '../types'
import { MOCK_TASKS, MOCK_PROJECTS } from '../lib/mockData'

/** Catalog used in browser / mock mode, where the main process isn't reachable. */
const FALLBACK_AGENTS: AgentDescriptor[] = ['claude-code', 'codex'].map((id) => ({
  id,
  label: PROCESS_LABELS[id],
  description: '',
  color: PROCESS_COLORS[id],
  enabled: true,
  available: false,
  supportsSummaries: true,
  settings: [],
  loginMethods: [],
  canLogout: false
}))

interface AppState {
  // Data
  tasks: Task[]
  projects: Project[]
  agents: AgentDescriptor[]
  selectedTaskId: string | null
  /** Task whose title is being edited in its header. */
  renamingTaskId: string | null
  selectedProjectId: string | null
  searchQuery: string
  statusFilter: string | null
  isCreateModalOpen: boolean
  isSettingsOpen: boolean
  isImportOpen: boolean
  /** Agent whose sign-in dialog is open. */
  signInAgentId: string | null
  isLoading: boolean

  // Actions
  setTasks: (tasks: Task[]) => void
  setProjects: (projects: Project[]) => void
  selectTask: (id: string | null) => void
  /** Opens the task with its title ready to edit; null ends editing. */
  startRename: (id: string | null) => void
  setProjectFilter: (id: string | null) => void
  setSearch: (q: string) => void
  setStatusFilter: (s: string | null) => void
  openCreateModal: () => void
  closeCreateModal: () => void
  openSettings: () => void
  closeSettings: () => void
  openImport: () => void
  closeImport: () => void
  openSignIn: (agentId: string) => void
  closeSignIn: () => void
  addTask: (task: Task) => void
  updateTask: (id: string, updates: Partial<Task>) => void
  deleteTask: (id: string) => void
  addProject: (project: Project) => void
  deleteProject: (id: string) => void
  loadData: () => Promise<void>
  refreshTasks: () => Promise<void>
  loadAgents: () => Promise<void>
}

const isElectron = typeof window !== 'undefined' && !!window.api

export const useAppStore = create<AppState>((set, get) => ({
  tasks: isElectron ? [] : MOCK_TASKS,
  projects: isElectron ? [] : MOCK_PROJECTS,
  agents: FALLBACK_AGENTS,
  selectedTaskId: null,
  renamingTaskId: null,
  selectedProjectId: null,
  searchQuery: '',
  statusFilter: null,
  isCreateModalOpen: false,
  isSettingsOpen: false,
  isImportOpen: false,
  signInAgentId: null,
  isLoading: false,

  setTasks: (tasks) => set({ tasks }),
  setProjects: (projects) => set({ projects }),

  selectTask: (id) => set({ selectedTaskId: id }),

  startRename: (id) => set(id ? { selectedTaskId: id, renamingTaskId: id } : { renamingTaskId: null }),

  setProjectFilter: (selectedProjectId) => set({ selectedProjectId, selectedTaskId: null }),

  setSearch: (searchQuery) => set({ searchQuery }),

  setStatusFilter: (statusFilter) => set({ statusFilter }),

  openCreateModal: () => set({ isCreateModalOpen: true }),
  closeCreateModal: () => set({ isCreateModalOpen: false }),
  openSettings: () => set({ isSettingsOpen: true }),
  closeSettings: () => set({ isSettingsOpen: false }),
  openImport: () => set({ isImportOpen: true }),
  closeImport: () => set({ isImportOpen: false }),
  openSignIn: (signInAgentId) => set({ signInAgentId }),
  closeSignIn: () => set({ signInAgentId: null }),

  addTask: (task) =>
    set((s) => ({ tasks: [task, ...s.tasks.filter((t) => t.id !== task.id)] })),

  updateTask: (id, updates) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t))
    })),

  deleteTask: (id) =>
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
      selectedTaskId: s.selectedTaskId === id ? null : s.selectedTaskId
    })),

  addProject: (project) => set((s) => ({ projects: [project, ...s.projects] })),

  deleteProject: (id) =>
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      tasks: s.tasks.filter((t) => t.project_id !== id),
      selectedProjectId: s.selectedProjectId === id ? null : s.selectedProjectId,
      selectedTaskId: s.tasks.find((t) => t.project_id === id && t.id === s.selectedTaskId)
        ? null
        : s.selectedTaskId
    })),

  loadData: async () => {
    if (!isElectron) return
    set({ isLoading: true })
    try {
      const [tasks, projects] = await Promise.all([
        window.api.tasks.getAll(),
        window.api.projects.getAll()
      ])
      set({ tasks, projects })
    } catch {
      // Keep mock data on error
    } finally {
      set({ isLoading: false })
    }
    await get().loadAgents()
  },

  loadAgents: async () => {
    if (!isElectron || !window.api.agents) return
    try {
      const agents: AgentDescriptor[] = await window.api.agents.list()
      if (agents?.length) set({ agents })
    } catch {
      // Keep the fallback catalog
    }
  },

  refreshTasks: async () => {
    if (!isElectron) return
    try {
      const tasks: Task[] = await window.api.tasks.getAll()
      if (tasks.length) {
        const deduped = tasks.filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
        set((s) => ({
          tasks: deduped.map((t) => {
            const existing = s.tasks.find((e) => e.id === t.id)
            // Preserve in-memory changed_files_count — DB value is stale (updated lazily)
            return existing && existing.changed_files_count > t.changed_files_count
              ? { ...t, changed_files_count: existing.changed_files_count }
              : t
          })
        }))
      }
    } catch {
      // ignore
    }
  }
}))

// Derived selectors
export const selectFilteredTasks = (state: AppState) => {
  let tasks = state.tasks
  if (state.selectedProjectId) {
    tasks = tasks.filter((t) => t.project_id === state.selectedProjectId)
  }
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase()
    tasks = tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.project_name.toLowerCase().includes(q) ||
        t.prompt.toLowerCase().includes(q)
    )
  }
  if (state.statusFilter) {
    tasks = tasks.filter((t) => t.status === state.statusFilter)
  }
  return tasks
}

export const selectSelectedTask = (state: AppState) =>
  state.selectedTaskId ? state.tasks.find((t) => t.id === state.selectedTaskId) ?? null : null
