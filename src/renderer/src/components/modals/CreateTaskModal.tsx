import React, { useState, useEffect, useRef } from 'react'
import { FolderOpen, GitBranch, Play, Zap, ChevronDown } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { useAppStore } from '../../stores/appStore'
import type { ProcessType, Task } from '../../types'

interface CreateTaskModalProps {
  open: boolean
  onClose: () => void
}

const PROMPT_SUGGESTIONS = [
  'Refactor the auth module to use JWT refresh tokens',
  'Fix the N+1 query in the users endpoint',
  'Add comprehensive tests for the payment service',
  'Implement rate limiting middleware',
  'Migrate the database schema to support multi-tenancy'
]

export function CreateTaskModal({ open, onClose }: CreateTaskModalProps) {
  const { projects, agents, addTask, addProject, loadAgents } = useAppStore()

  /** First installed agent, else first selectable one — used as the initial choice. */
  const defaultAgentId = (): ProcessType => {
    const selectable = agents.filter((a) => a.enabled)
    return (selectable.find((a) => a.available) ?? selectable[0])?.id ?? 'claude-code'
  }

  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [projectId, setProjectId] = useState('')
  const [processType, setProcessType] = useState<ProcessType>(defaultAgentId)
  const [branch, setBranch] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [newProjectPath, setNewProjectPath] = useState('')
  const [error, setError] = useState('')
  const [localBranches, setLocalBranches] = useState<string[]>([])

  const isElectron = typeof window !== 'undefined' && !!window.api

  // Re-probe which agent CLIs are installed each time the modal opens
  useEffect(() => {
    if (open) loadAgents()
  }, [open, loadAgents])

  // Keep the selection valid once the real catalog arrives
  useEffect(() => {
    const current = agents.find((a) => a.id === processType)
    if (!current?.enabled) setProcessType(defaultAgentId())
  }, [agents]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch branches whenever a project path is selected
  useEffect(() => {
    const path = newProjectPath || (projectId ? projects.find((p) => p.id === projectId)?.path : '')
    if (!path || !isElectron) { setLocalBranches([]); return }
    window.api.git.getBranches(path).then(setLocalBranches).catch(() => setLocalBranches([]))
  }, [newProjectPath, projectId, projects, isElectron])

  const handleFolderPick = async () => {
    if (!isElectron) return
    const path = await window.api.dialog.openFolder()
    if (path) {
      setNewProjectPath(path)
      const name = path.split(/[/\\]/).pop() ?? path
      setTitle((prev) => prev || `Task in ${name}`)
    }
  }

  const handleCreate = async () => {
    if (!title.trim() || !prompt.trim()) return
    setError('')
    setIsCreating(true)

    try {
      const now = Math.floor(Date.now() / 1000)
      let resolvedId = ''
      let resolvedName = ''
      let resolvedPath = ''

      if (isElectron) {
        if (newProjectPath) {
          // Create or find project by path (server handles duplicates via INSERT OR IGNORE)
          const name = newProjectPath.split(/[/\\]/).pop() ?? 'project'
          const created = await window.api.projects.create({ name, path: newProjectPath })
          resolvedId = created.id
          resolvedName = created.name
          resolvedPath = created.path
          // Sync to store (replace if already there, add if new)
          addProject({ ...created, created_at: now, updated_at: now })
        } else if (projectId) {
          const proj = projects.find((p) => p.id === projectId)
          if (!proj) {
            setError('Selected project not found. Please pick a folder instead.')
            return
          }
          resolvedId = proj.id
          resolvedName = proj.name
          resolvedPath = proj.path
        } else {
          setError('Please select a project or click Browse to pick a folder.')
          return
        }
      } else {
        // Browser / mock mode — no DB, use whatever is selected
        const proj = projects.find((p) => p.id === projectId) ?? projects[0]
        resolvedId = proj?.id ?? 'mock'
        resolvedName = proj?.name ?? 'project'
        resolvedPath = newProjectPath || (proj?.path ?? '')
      }

      const newTask: Task = {
        id: crypto.randomUUID(), // overwritten below in Electron
        project_id: resolvedId,
        project_name: resolvedName,
        project_path: resolvedPath,
        title: title.trim(),
        prompt: prompt.trim(),
        process_type: processType,
        status: 'running',
        branch: branch || undefined,
        started_at: now,
        updated_at: now,
        created_at: now,
        runtime_seconds: 0,
        changed_files_count: 0,
        notes: ''
      }

      if (isElectron) {
        const created = await window.api.tasks.create({
          projectId: resolvedId,
          title: newTask.title,
          prompt: newTask.prompt,
          processType,
          branch: branch || undefined,
          cwd: resolvedPath
        })
        newTask.id = created.id
      }

      addTask(newTask)
      onClose()
      resetForm()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task.')
    } finally {
      setIsCreating(false)
    }
  }

  const resetForm = () => {
    setTitle('')
    setPrompt('')
    setProjectId('')
    setProcessType(defaultAgentId())
    setBranch('')
    setNewProjectPath('')
    setLocalBranches([])
    setError('')
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-blue-600 flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-white" />
            </div>
            New Task
          </DialogTitle>
          <DialogDescription>
            Start a new AI coding session. Tasks are persistent — you can always resume them.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-2 space-y-4">
          {/* Task title */}
          <Field label="Task Name" required>
            <Input
              placeholder="e.g. Refactor auth to use JWT"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </Field>

          {/* Project */}
          <Field label="Project" required>
            <div className="flex gap-2">
              {!newProjectPath && (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder={isElectron ? 'Pick a folder or select existing...' : 'Select project...'} />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5 h-9"
                onClick={handleFolderPick}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {newProjectPath ? 'Change' : 'Browse'}
              </Button>
            </div>
            {newProjectPath && (
              <div className="flex items-center gap-2 mt-1">
                <p className="text-[11px] text-zinc-400 font-mono flex-1 truncate">{newProjectPath}</p>
                <button
                  onClick={() => setNewProjectPath('')}
                  className="text-[10px] text-zinc-600 hover:text-zinc-400 shrink-0"
                >
                  ✕ clear
                </button>
              </div>
            )}
          </Field>

          {/* Agent — catalog comes from the main process, so new agents appear here automatically */}
          <Field label="Agent">
            <div className="grid grid-cols-3 gap-2">
              {agents.map((agent) => {
                const selected = processType === agent.id
                const disabled = !agent.enabled
                return (
                  <button
                    key={agent.id}
                    type="button"
                    disabled={disabled}
                    title={
                      disabled
                        ? agent.description
                        : agent.available
                          ? agent.description
                          : `${agent.description} — CLI not found on PATH`
                    }
                    onClick={() => !disabled && setProcessType(agent.id)}
                    className={[
                      'relative flex items-center justify-between gap-1.5 rounded-lg border px-2.5 py-2.5 transition-colors',
                      disabled
                        ? 'cursor-not-allowed border-white/[0.04] bg-white/[0.01] opacity-40'
                        : selected
                          ? 'border-blue-500/50 bg-blue-500/10 text-zinc-100'
                          : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-white/[0.12] hover:text-zinc-300'
                    ].join(' ')}
                  >
                    <div className="flex flex-col items-start min-w-0">
                      <span className="text-[11px] font-medium leading-tight truncate">{agent.label}</span>
                      {disabled && (
                        <span className="text-[9px] text-zinc-600 leading-none">soon</span>
                      )}
                      {!disabled && !agent.available && (
                        <span className="text-[9px] text-amber-500/70 leading-none">not installed</span>
                      )}
                    </div>
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: agent.color }}
                    />
                  </button>
                )
              })}
            </div>
          </Field>

          {/* Prompt */}
          <Field label="Initial Prompt" required>
            <Textarea
              placeholder="Describe what you want the agent to do..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-[240px]"
            />
            {/* Suggestions */}
            {!prompt && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {PROMPT_SUGGESTIONS.slice(0, 3).map((s) => (
                  <button
                    key={s}
                    onClick={() => setPrompt(s)}
                    className="text-[10px] px-2 py-1 rounded-md border border-white/[0.06] bg-white/[0.02] text-zinc-500 hover:text-zinc-300 hover:border-white/[0.10] transition-colors text-left"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </Field>

          {/* Merge target branch (optional) */}
          <Field label="Merge into branch" optional>
            <BranchCombobox
              branches={localBranches}
              value={branch}
              onChange={setBranch}
            />
          </Field>
        </div>

        {error && (
          <div className="px-6 pb-2">
            <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              {error}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreate}
            disabled={!title.trim() || !prompt.trim() || isCreating}
            className="gap-1.5"
          >
            {isCreating ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                Start Task
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BranchCombobox({
  branches,
  value,
  onChange
}: {
  branches: string[]
  value: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  const filtered = branches
    .filter((b) => !query || b.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 5)

  const displayValue = query || value

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <GitBranch className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none z-10" />
      <Input
        placeholder="e.g. main, develop (branch to merge into when done)"
        value={displayValue}
        onChange={(e) => {
          const v = e.target.value
          setQuery(v)
          onChange(v)
          if (branches.length > 0) setOpen(true)
        }}
        onFocus={() => { if (branches.length > 0) setOpen(true) }}
        className={branches.length > 0 ? 'pl-8 pr-8' : 'pl-8'}
      />
      {branches.length > 0 && (
        <button
          type="button"
          tabIndex={-1}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}
      {open && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-white/[0.08] bg-[#1a1a1a] shadow-xl py-1 z-50 max-h-[180px] overflow-y-auto">
          {filtered.map((b) => (
            <button
              key={b}
              type="button"
              className="flex items-center gap-2 w-full px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.06] transition-colors text-left"
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(b)
                setQuery('')
                setOpen(false)
              }}
            >
              <GitBranch className="w-3 h-3 text-zinc-500 shrink-0" />
              <span className="font-mono truncate">{b}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  children,
  required,
  optional
}: {
  label: string
  children: React.ReactNode
  required?: boolean
  optional?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
        {label}
        {required && <span className="text-blue-500">*</span>}
        {optional && <span className="text-zinc-600 font-normal">(optional)</span>}
      </label>
      {children}
    </div>
  )
}
