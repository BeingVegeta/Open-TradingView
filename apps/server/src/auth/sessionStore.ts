import type { SessionUser } from '@otv/shared';
import type { Db } from '../db';

export interface StoredSession {
  apiKey: string;
  accessToken: string;
  user: SessionUser;
  loginTime: number;
  expiresAt: number;
}

interface Row {
  api_key: string;
  access_token: string;
  user_id: string;
  user_name: string;
  user_shortname: string | null;
  email: string | null;
  broker: string | null;
  login_time: number;
  expires_at: number;
}

/** Persists the one Kite session so it survives server restarts until it expires. */
export class SessionStore {
  constructor(private readonly db: Db) {}

  load(): StoredSession | null {
    const row = this.db.prepare('SELECT * FROM session WHERE id = 1').get() as Row | undefined;
    if (!row) return null;
    const user: SessionUser = { userId: row.user_id, userName: row.user_name };
    if (row.user_shortname) user.userShortname = row.user_shortname;
    if (row.email) user.email = row.email;
    if (row.broker) user.broker = row.broker;
    return {
      apiKey: row.api_key,
      accessToken: row.access_token,
      user,
      loginTime: row.login_time,
      expiresAt: row.expires_at,
    };
  }

  save(s: StoredSession): void {
    this.db
      .prepare(
        `INSERT INTO session (id, api_key, access_token, user_id, user_name, user_shortname, email, broker, login_time, expires_at)
         VALUES (1, @apiKey, @accessToken, @userId, @userName, @userShortname, @email, @broker, @loginTime, @expiresAt)
         ON CONFLICT (id) DO UPDATE SET
           api_key = excluded.api_key, access_token = excluded.access_token,
           user_id = excluded.user_id, user_name = excluded.user_name,
           user_shortname = excluded.user_shortname, email = excluded.email, broker = excluded.broker,
           login_time = excluded.login_time, expires_at = excluded.expires_at`,
      )
      .run({
        apiKey: s.apiKey,
        accessToken: s.accessToken,
        userId: s.user.userId,
        userName: s.user.userName,
        userShortname: s.user.userShortname ?? null,
        email: s.user.email ?? null,
        broker: s.user.broker ?? null,
        loginTime: s.loginTime,
        expiresAt: s.expiresAt,
      });
  }

  clear(): void {
    this.db.prepare('DELETE FROM session WHERE id = 1').run();
  }
}
