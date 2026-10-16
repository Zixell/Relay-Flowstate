import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { MessageAttachment } from '../db'

/**
 * Images the user attaches to chat messages. Stored as files next to the
 * database rather than in it, so loading history stays cheap; the renderer
 * fetches each one on demand.
 */

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

function dirFor(taskId: string): string {
  return join(app.getPath('userData'), 'attachments', taskId)
}

function fileFor(taskId: string, a: MessageAttachment): string {
  return join(dirFor(taskId), `${a.id}.${EXT[a.mediaType] ?? 'bin'}`)
}

export function saveAttachment(taskId: string, image: { mediaType: string; data: string }): MessageAttachment {
  const attachment = { id: randomUUID(), mediaType: image.mediaType }
  mkdirSync(dirFor(taskId), { recursive: true })
  writeFileSync(fileFor(taskId, attachment), Buffer.from(image.data, 'base64'))
  return attachment
}

export function readAttachment(taskId: string, id: string): string | null {
  // Ids are server-generated UUIDs; anything else must not reach the filesystem.
  const UUID = /^[0-9a-f-]{36}$/i
  if (!UUID.test(id) || !UUID.test(taskId)) return null
  for (const [mediaType] of Object.entries(EXT)) {
    const path = fileFor(taskId, { id, mediaType })
    if (existsSync(path)) return `data:${mediaType};base64,${readFileSync(path).toString('base64')}`
  }
  return null
}

export function deleteAttachments(taskId: string): void {
  rmSync(dirFor(taskId), { recursive: true, force: true })
}
