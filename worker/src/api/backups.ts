import { Hono, type Context } from 'hono';
import type { AppEnv } from '../auth/principal';
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

function refuse(c: Context<AppEnv>): Response | null {
  const user = c.get('user');
  if (!user) return apiError(c, 401, 'unauthorized', 'session required');
  const admins = (c.env.BACKUP_ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim());
  return admins.includes(user.id)
    ? null
    : apiError(c, 403, 'forbidden', 'backup admin required');
}

function view(row: BackupRow) {
  const { cursor, ...rest } = row;
  void cursor;
  return rest;
}

backupsRoutes.get('/admin/backups', async (c) => {
  try {
    const refused = refuse(c);
    if (refused) return refused;
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
    const refused = refuse(c);
    if (refused) return refused;
    let row: BackupRow | null;
    try {
      row = await startBackup(c.env, 'manual', c.get('user')!.id);
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
