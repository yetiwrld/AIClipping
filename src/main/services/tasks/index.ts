import { AppError } from '@shared/errors'
import type { TaskInfo, TaskType } from '@shared/types'
import type { AppContext } from '../app-context'
import { tasksRepo } from '../database/repositories'

/**
 * Task manager: explicit lifecycle for long operations + crash recovery.
 * Runners are registered by the IPC layer, so resume/restart can re-dispatch
 * an interrupted task from its persisted payload (spec §37/§88).
 */

export type TaskReporter = (stage: string, progress: number | null, message: string) => void

export interface TaskRunner {
  (payload: Record<string, unknown>, report: TaskReporter, signal: AbortSignal): Promise<unknown>
}

export class TaskManager {
  private runners = new Map<TaskType, TaskRunner>()
  private controllers = new Map<string, AbortController>()

  constructor(private ctx: AppContext) {}

  registerRunner(type: TaskType, runner: TaskRunner): void {
    this.runners.set(type, runner)
  }

  create(type: TaskType, projectId: string | null, payload: Record<string, unknown> = {}): TaskInfo {
    const id = crypto.randomUUID()
    const task = tasksRepo.create(this.ctx.db, { id, type, projectId, payload })
    this.emit(task)
    return task
  }

  private emit(task: TaskInfo | null): void {
    if (task) this.ctx.events.publish({ type: 'task:update', task })
  }

  private update(id: string, patch: Parameters<typeof tasksRepo.update>[2]): TaskInfo | null {
    tasksRepo.update(this.ctx.db, id, patch)
    const task = tasksRepo.get(this.ctx.db, id)
    this.emit(task)
    return task
  }

  async run<T>(taskId: string, fn: (report: TaskReporter, signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    this.controllers.set(taskId, controller)
    this.update(taskId, { state: 'running', stage: 'starting', message: 'Starting' })
    const report: TaskReporter = (stage, progress, message) => {
      this.update(taskId, { stage, progress, message })
    }
    try {
      const result = await fn(report, controller.signal)
      this.update(taskId, { state: 'completed', progress: 1, message: 'Completed' })
      return result
    } catch (err) {
      if (controller.signal.aborted) {
        this.update(taskId, { state: 'cancelled', message: 'Cancelled by user' })
      } else {
        const structured = err instanceof AppError ? err.toStructured() : { code: 'INTERNAL', message: String(err) }
        this.update(taskId, { state: 'failed', error: structured, message: structured.message })
      }
      throw err
    } finally {
      this.controllers.delete(taskId)
    }
  }

  cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId)
    if (controller) {
      controller.abort()
      return true
    }
    return false
  }

  list(projectId?: string): TaskInfo[] {
    return tasksRepo.list(this.ctx.db, projectId)
  }

  /** Startup: mark in-flight tasks interrupted (never auto-restart). */
  startupRecovery(): TaskInfo[] {
    return tasksRepo.markInterruptedOnLaunch(this.ctx.db)
  }

  /** Re-run an interrupted/failed task from its stored payload. */
  async resume(taskId: string): Promise<void> {
    const task = tasksRepo.get(this.ctx.db, taskId)
    if (!task) throw new AppError('TASK_NOT_FOUND', 'That task no longer exists.')
    if (task.state === 'running' || task.state === 'queued') return
    const runner = this.runners.get(task.type)
    if (!runner) {
      throw new AppError('TASK_RUNNER_MISSING', `This task type (${task.type}) cannot be resumed automatically.`, 'Start the operation again from the project.')
    }
    tasksRepo.update(this.ctx.db, taskId, { state: 'queued', error: null, message: 'Queued for retry' })
    const payload = JSON.parse(
      (this.ctx.db.get<{ payload: string }>('SELECT payload FROM tasks WHERE id = ?', [taskId])?.payload) ?? '{}'
    ) as Record<string, unknown>
    this.emit(tasksRepo.get(this.ctx.db, taskId))
    await this.run(taskId, (report, signal) => runner(payload, report, signal))
  }

  discard(taskId: string): void {
    const task = tasksRepo.get(this.ctx.db, taskId)
    if (!task) return
    this.cancel(taskId)
    this.update(taskId, { state: 'cancelled', message: 'Discarded by user' })
  }
}
