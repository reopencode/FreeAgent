import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, FileText, Folder, FolderKanban, FolderOpen, Loader2, MessageSquarePlus, Plus, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { timeAgo } from '@/lib/format'
import { useNav } from '@/lib/nav'
import { keys, usePlugins, useProject, useProjects } from '@/lib/queries'

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const { go } = useNav()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
    }
  }, [open])
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/projects', { name, description }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: keys.projects })
      onOpenChange(false)
      go({ view: 'projects', projectId: p.id })
    },
    onError: (e) => toast.error(e.message)
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Group chats with shared instructions, files and a working folder.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="p-name">Name</Label>
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Personal website" autoFocus />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="p-desc">What is it about?</Label>
            <Input id="p-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="A Next.js portfolio site" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending && <Loader2 className="animate-spin" />}
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProjectDetail({ projectId }: { projectId: string }): React.JSX.Element {
  const { go } = useNav()
  const qc = useQueryClient()
  const project = useProject(projectId)
  const plugins = usePlugins()
  const [instructions, setInstructions] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (project.data) setInstructions(project.data.project.instructions)
  }, [project.data?.project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: keys.project(projectId) })
    void qc.invalidateQueries({ queryKey: keys.projects })
  }
  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/api/projects/${projectId}`, patch),
    onSuccess: () => {
      invalidate()
      toast.success('Saved')
    },
    onError: (e) => toast.error(e.message)
  })
  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      for (const f of Array.from(files)) {
        if (f.size > 2_000_000) throw new Error(`${f.name} is larger than 2 MB`)
        await api.post(`/api/projects/${projectId}/files`, { name: f.name, content: await f.text() })
      }
    },
    onSuccess: () => {
      invalidate()
      toast.success('Files added')
    },
    onError: (e) => toast.error(e.message)
  })
  const removeFile = useMutation({ mutationFn: (id: string) => api.del(`/api/project-files/${id}`), onSuccess: invalidate })
  const remove = useMutation({
    mutationFn: () => api.del(`/api/projects/${projectId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.projects })
      void qc.invalidateQueries({ queryKey: keys.chats })
      go({ view: 'projects' })
    }
  })

  const pickFolder = async (): Promise<void> => {
    if (!window.freeagent) {
      const path = window.prompt('Folder path for this project')
      if (path) update.mutate({ workspaceDir: path })
      return
    }
    const dir = await window.freeagent.pickFolder()
    if (dir) update.mutate({ workspaceDir: dir })
  }

  if (project.isLoading) return <Skeleton className="m-8 h-64" />
  if (project.isError || !project.data) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Project not found.{' '}
        <Button variant="link" onClick={() => go({ view: 'projects' })}>
          Back to projects
        </Button>
      </div>
    )
  }
  const { project: p, files, chats, workspace } = project.data

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <Button variant="ghost" size="sm" className="-ml-2 mb-3 text-muted-foreground" onClick={() => go({ view: 'projects' })}>
        <ArrowLeft />
        All projects
      </Button>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-3xl tracking-tight">{p.name}</h1>
          {p.description && <p className="mt-1 text-muted-foreground">{p.description}</p>}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => setConfirmDelete(true)} aria-label="Delete project">
            <Trash2 />
          </Button>
          <Button onClick={() => go({ view: 'chat', projectId: p.id })}>
            <MessageSquarePlus />
            New chat
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section>
          <h2 className="mb-2 text-sm font-medium">Chats</h2>
          {chats.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No chats in this project yet.</div>
          ) : (
            <div className="divide-y rounded-xl border bg-card">
              {chats.map((c) => (
                <button key={c.id} onClick={() => go({ view: 'chat', chatId: c.id })} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/50">
                  <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
                  <span className="text-xs text-muted-foreground">{timeAgo(c.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-5">
          <div className="rounded-xl border bg-card p-4">
            <h3 className="mb-1 text-sm font-medium">Instructions</h3>
            <p className="mb-2 text-xs text-muted-foreground">Added to every chat in this project.</p>
            <Textarea rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Use TypeScript. Keep answers short. The audience is…" />
            <Button size="sm" className="mt-2" disabled={instructions === p.instructions || update.isPending} onClick={() => update.mutate({ instructions })}>
              Save instructions
            </Button>
          </div>

          <div className="rounded-xl border bg-card p-4">
            <h3 className="mb-1 text-sm font-medium">Plugins</h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Instruction packs for chats in this project. A chat can override the set. AGENTS.md in the working folder is loaded on its own, and skills in .freeagent/skills are available to the agent.
            </p>
            {(plugins.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No plugins yet. Add one in Customize.</p>
            ) : (
              <div className="space-y-3">
                {(plugins.data ?? []).map((plugin) => (
                  <div key={plugin.id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{plugin.name}</p>
                      {plugin.description && <p className="truncate text-xs text-muted-foreground">{plugin.description}</p>}
                    </div>
                    <Switch
                      checked={p.enabledPlugins.includes(plugin.id)}
                      onCheckedChange={(on) => {
                        const enabledPlugins = on ? [...p.enabledPlugins, plugin.id] : p.enabledPlugins.filter((id) => id !== plugin.id)
                        update.mutate({ enabledPlugins })
                      }}
                      aria-label={`Turn ${plugin.name} ${p.enabledPlugins.includes(plugin.id) ? 'off' : 'on'}`}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-card p-4">
            <h3 className="mb-1 text-sm font-medium">Working folder</h3>
            <p className="mb-2 text-xs text-muted-foreground">Agent tools, OpenCode, Kiro and Claude Code work inside this folder.</p>
            <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">
              <Folder className="size-3.5 shrink-0" />
              {p.workspaceDir ?? `${workspace} (default)`}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void pickFolder()}>
                <FolderOpen />
                Choose folder
              </Button>
              {p.workspaceDir && (
                <Button size="sm" variant="ghost" onClick={() => update.mutate({ workspaceDir: null })}>
                  Reset
                </Button>
              )}
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">Files</h3>
                <p className="text-xs text-muted-foreground">Text files used as context.</p>
              </div>
              <Button size="sm" variant="outline" disabled={upload.isPending} onClick={() => fileInput.current?.click()}>
                {upload.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
                Add
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                accept=".txt,.md,.json,.csv,.ts,.tsx,.js,.py,.html,.css,.yaml,.yml,.xml,.sql,.go,.rs,.java,.c,.cpp,.sh"
                onChange={(e) => {
                  if (e.target.files?.length) upload.mutate(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>
            {files.length === 0 ? (
              <p className="text-xs text-muted-foreground">No files yet.</p>
            ) : (
              <ul className="space-y-1">
                {files.map((f) => (
                  <li key={f.id} className="group flex items-center gap-2 text-sm">
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="text-xs text-muted-foreground">{(f.size / 1024).toFixed(1)} KB</span>
                    <Button variant="ghost" size="icon" className="size-6 opacity-0 group-hover:opacity-100" onClick={() => removeFile.mutate(f.id)} aria-label={`Remove ${f.name}`}>
                      <Trash2 className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{p.name}”?</AlertDialogTitle>
            <AlertDialogDescription>Its files and instructions are removed. Chats stay in your history without a project. The working folder on disk is not touched.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function ProjectsView({ projectId }: { projectId?: string }): React.JSX.Element {
  const { go } = useNav()
  const projects = useProjects()
  const [creating, setCreating] = useState(false)

  if (projectId) {
    return (
      <div className="h-full overflow-y-auto">
        <ProjectDetail projectId={projectId} />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-3xl tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">Shared instructions, files and a working folder for related chats.</p>
          </div>
          <Button onClick={() => setCreating(true)}>
            <Plus />
            New project
          </Button>
        </div>
        {projects.isLoading && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        )}
        {projects.isError && <p className="text-sm text-destructive">Could not load projects: {projects.error.message}</p>}
        {projects.data?.length === 0 && (
          <div className="rounded-xl border border-dashed p-10 text-center">
            <FolderKanban className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">No projects yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Create one to give the agent a folder to work in and instructions it always follows.</p>
            <Button className="mt-4" onClick={() => setCreating(true)}>
              <Plus />
              Create your first project
            </Button>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.data?.map((p) => (
            <button key={p.id} onClick={() => go({ view: 'projects', projectId: p.id })} className="flex flex-col rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/40">
              <span className="font-medium">{p.name}</span>
              <span className="mt-1 line-clamp-2 min-h-10 text-sm text-muted-foreground">{p.description || p.instructions || 'No description'}</span>
              <span className="mt-3 text-xs text-muted-foreground">
                {p.chatCount} chat{p.chatCount === 1 ? '' : 's'} · {p.fileCount} file{p.fileCount === 1 ? '' : 's'} · updated {timeAgo(p.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      </div>
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}
