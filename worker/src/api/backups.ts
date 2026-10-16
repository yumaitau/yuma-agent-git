import { Hono } from 'hono';
import type { AppEnv } from '../auth/principal';
import type { Env } from '../env';
import { recordAudit } from '../audit/record';
import { BackupConfigError, startBackup, type BackupRow } from '../backup/backup';
import { q } from '../db/client';
import { apiError, errorResponse } from './errors';

/**
 * Backups (issue #70), for the user ids in `BACKUP_ADMIN_USER_IDS`:
 *   GET  /admin/backups   recent backups and restores, newest first
 *   POST /admin/backups   start a backup now (the cron moves it along)
 * Restores are not started here: they run in a fresh environment
 * (docs/operations/backup-dr.md).
 */
export const backupsRoutes = new Hono<AppEnv>();

function isBackupAdmin(env: Env, userId: string): boolean {
  return (env.BACKUP_ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(userId);
}

function view(row: BackupRow) {
  const { cursor, ...rest } = row;
  void cursor;
  return rest;
}

backupsRoutes.get('/admin/backups', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    if (!isBackupAdmin(c.env, user.id))
      return apiError(c, 403, 'forbidden', 'backup admin required');
    const rows = await q<BackupRow>(
      c.env,
      'SELECT * FROM backups ORDER BY started_at DESC LIMIT 50',
    );
    return c.json({ backups: rows.map(view) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

backupsRoutes.post('/admin/backups', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return apiError(c, 401, 'unauthorized', 'session required');
    if (!isBackupAdmin(c.env, user.id))
      return apiError(c, 403, 'forbidden', 'backup admin required');
    let row: BackupRow | null;
    try {
      row = await startBackup(c.env, 'manual', user.id);
    } catch (err) {
      if (err instanceof BackupConfigError)
        return apiError(c, 503, 'backups_unavailable', err.message);
      throw err;
    }
    if (!row) return apiError(c, 409, 'backup_running', 'a backup is already running');
    await recordAudit(c, { action: 'backup.create', target: { backup_id: row.id } });
    return c.json({ backup: view(row) }, 202);
  } catch (err) {
    return errorResponse(c, err);
  }
});
