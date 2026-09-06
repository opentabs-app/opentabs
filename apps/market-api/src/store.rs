//! Storage. SQLite, because the marketplace is one table of documents and a
//! counter, and reaching for a cluster to hold that would be pretending.
//!
//! # What this schema deliberately cannot answer
//!
//! There is no `user_id` column anywhere. A like is a row holding an opaque
//! token (see `tabs_market::like_token`) and nothing else, so:
//!
//!   * "has this account already liked this pack" is a lookup — which is all
//!     the feature needs;
//!   * "what has this account liked" has **no query that answers it**, because
//!     the column that would answer it does not exist.
//!
//! The publishing allowance needs to know how often an account has published
//! recently, which is the one place a per-account fact is unavoidable. It is
//! stored the same way — a token, plus a timestamp — and swept, so it is a
//! rate limiter's memory rather than a history.

use rusqlite::{params, Connection, OptionalExtension};
use std::sync::{Mutex, MutexGuard};
use tabs_market::Listing;

pub struct Store {
    conn: Mutex<Connection>,
}

/// How long a publish record is kept. Just past the window it enforces:
/// keeping them longer would turn a rate limiter into a log of who published
/// what and when.
const PUBLISH_RETENTION_SECS: i64 = 2 * 86_400;

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Store> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS listings (
                id          TEXT PRIMARY KEY,
                kind        TEXT NOT NULL,
                name        TEXT NOT NULL,
                description TEXT NOT NULL,
                author      TEXT NOT NULL,
                tags        TEXT NOT NULL DEFAULT '',
                image       TEXT,
                video       TEXT,
                pack        TEXT NOT NULL,
                published   INTEGER NOT NULL,
                updated     INTEGER NOT NULL,
                likes       INTEGER NOT NULL DEFAULT 0,
                installs    INTEGER NOT NULL DEFAULT 0,
                hidden      INTEGER NOT NULL DEFAULT 0,
                -- Who may edit this listing, as a token. Not an account id:
                -- the server can recognise the owner returning without being
                -- able to list what anyone owns.
                owner_token TEXT NOT NULL
            );

            -- One row per like. A token and nothing else, on purpose.
            CREATE TABLE IF NOT EXISTS likes (
                token TEXT PRIMARY KEY
            );

            -- A rate limiter's memory, swept after the window it enforces.
            CREATE TABLE IF NOT EXISTS publishes (
                token TEXT NOT NULL,
                at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS publishes_at ON publishes(at);
            CREATE INDEX IF NOT EXISTS listings_published ON listings(published);
            "#,
        )?;
        Ok(Store {
            conn: Mutex::new(conn),
        })
    }

    /// An ephemeral database, for tests.
    #[allow(dead_code)]
    pub fn memory() -> rusqlite::Result<Store> {
        Store::open(":memory:")
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock means a previous request panicked mid-write. The
        // data is still consistent (SQLite is transactional), so recovering
        // beats refusing every request thereafter.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Every listing, for the ranking functions to filter and sort in memory.
    ///
    /// Ranking in SQL would mean expressing a decay curve in it, and then
    /// having two definitions of "trending" to keep in step. At the size this
    /// runs at, loading and sorting is faster than the round trip anyway.
    pub fn all_listings(&self) -> rusqlite::Result<Vec<Listing>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, description, author, tags, image, video,
                    published, updated, likes, installs, hidden
             FROM listings",
        )?;
        let rows = stmt.query_map([], |r| {
            let tags: String = r.get(5)?;
            Ok(Listing {
                id: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                description: r.get(3)?,
                author: r.get(4)?,
                tags: tags
                    .split(',')
                    .filter(|t| !t.is_empty())
                    .map(str::to_string)
                    .collect(),
                image: r.get(6)?,
                video: r.get(7)?,
                published: r.get(8)?,
                updated: r.get(9)?,
                likes: r.get::<_, i64>(10)? as u64,
                installs: r.get::<_, i64>(11)? as u64,
                hidden: r.get::<_, i64>(12)? != 0,
            })
        })?;
        rows.collect()
    }

    pub fn listing(&self, id: &str) -> rusqlite::Result<Option<Listing>> {
        Ok(self.all_listings()?.into_iter().find(|l| l.id == id))
    }

    /// The pack document, as stored JSON.
    pub fn pack_json(&self, id: &str) -> rusqlite::Result<Option<String>> {
        self.lock()
            .query_row(
                "SELECT pack FROM listings WHERE id = ?1 AND hidden = 0",
                [id],
                |r| r.get(0),
            )
            .optional()
    }

    /// Is this id already taken?
    pub fn exists(&self, id: &str) -> rusqlite::Result<bool> {
        Ok(self
            .lock()
            .query_row("SELECT 1 FROM listings WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// Insert or replace, keeping the counters a listing has already earned.
    ///
    /// An edit must not reset likes and installs to zero — that would make
    /// "edit your description" a way to erase your own reception, and a way
    /// for a good listing to look new again.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert(
        &self,
        listing: &Listing,
        pack_json: &str,
        owner_token: &str,
        hidden: bool,
    ) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO listings
               (id, kind, name, description, author, tags, image, video, pack,
                published, updated, likes, installs, hidden, owner_token)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,0,?12,?13)
             ON CONFLICT(id) DO UPDATE SET
               kind=excluded.kind, name=excluded.name,
               description=excluded.description, author=excluded.author,
               tags=excluded.tags, image=excluded.image, video=excluded.video,
               pack=excluded.pack, updated=excluded.updated,
               hidden=excluded.hidden",
            params![
                listing.id,
                listing.kind,
                listing.name,
                listing.description,
                listing.author,
                listing.tags.join(","),
                listing.image,
                listing.video,
                pack_json,
                listing.published,
                listing.updated,
                hidden as i64,
                owner_token,
            ],
        )?;
        Ok(())
    }

    /// The owner token on a listing, to check before letting an edit through.
    pub fn owner_token(&self, id: &str) -> rusqlite::Result<Option<String>> {
        self.lock()
            .query_row(
                "SELECT owner_token FROM listings WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()
    }

    /// Record a like. `false` means this account had already liked it.
    ///
    /// The uniqueness is enforced by the primary key rather than by a read
    /// followed by a write: two clicks arriving together would both pass the
    /// read and both increment.
    pub fn like(&self, token: &str, pack_id: &str) -> rusqlite::Result<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let inserted = tx.execute("INSERT OR IGNORE INTO likes (token) VALUES (?1)", [token])?;
        if inserted == 0 {
            tx.rollback()?;
            return Ok(false);
        }
        tx.execute(
            "UPDATE listings SET likes = likes + 1 WHERE id = ?1",
            [pack_id],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Withdraw a like. `false` means there was nothing to withdraw.
    pub fn unlike(&self, token: &str, pack_id: &str) -> rusqlite::Result<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let removed = tx.execute("DELETE FROM likes WHERE token = ?1", [token])?;
        if removed == 0 {
            tx.rollback()?;
            return Ok(false);
        }
        // `MAX(0, …)` because a counter that can go negative will, given a
        // restored backup or a hand-edited row.
        tx.execute(
            "UPDATE listings SET likes = MAX(0, likes - 1) WHERE id = ?1",
            [pack_id],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn has_liked(&self, token: &str) -> rusqlite::Result<bool> {
        Ok(self
            .lock()
            .query_row("SELECT 1 FROM likes WHERE token = ?1", [token], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// Count an install. Anonymous — there is nothing here to attribute.
    pub fn count_install(&self, id: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE listings SET installs = installs + 1 WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    /// When this account published recently, for the allowance check.
    pub fn recent_publishes(&self, token: &str, now: i64) -> rusqlite::Result<Vec<i64>> {
        let conn = self.lock();
        // Swept on read: no cron, and the table cannot grow into a history.
        conn.execute(
            "DELETE FROM publishes WHERE at < ?1",
            [now - PUBLISH_RETENTION_SECS],
        )?;
        let mut stmt = conn.prepare("SELECT at FROM publishes WHERE token = ?1")?;
        let rows = stmt.query_map([token], |r| r.get(0))?;
        rows.collect()
    }

    pub fn note_publish(&self, token: &str, now: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO publishes (token, at) VALUES (?1, ?2)",
            params![token, now],
        )?;
        Ok(())
    }

    /// Hide or restore a listing. Kept rather than deleted so it is undoable.
    pub fn set_hidden(&self, id: &str, hidden: bool) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE listings SET hidden = ?2 WHERE id = ?1",
            params![id, hidden as i64],
        )?;
        Ok(())
    }

    /// The columns the `likes` table actually has.
    ///
    /// Exposed so the privacy claim can be asserted against the schema rather
    /// than against a comment: "what has this account liked" must have no
    /// query that answers it, and the way to keep that true as the schema
    /// changes is to fail a test when a column appears.
    #[allow(dead_code)]
    pub fn likes_columns(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.lock();
        let stmt = conn.prepare("SELECT * FROM likes")?;
        Ok(stmt.column_names().iter().map(|s| s.to_string()).collect())
    }

    /// Every stored like token, for the same reason.
    #[allow(dead_code)]
    pub fn like_tokens(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT token FROM likes")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect()
    }

    pub fn delete(&self, id: &str) -> rusqlite::Result<()> {
        self.lock()
            .execute("DELETE FROM listings WHERE id = ?1", [id])?;
        Ok(())
    }
}
