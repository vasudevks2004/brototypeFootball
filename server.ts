import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const dbPath = path.join(process.cwd(), "db.json");

  // Supabase central parameters
  const SUPABASE_URL = process.env.SUPABASE_URL || "https://vjtirydmavuknpruxutq.supabase.co";
  const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_vI8Y4wnhM3AuOxkSh8Wjqw_Sf4vIdpn";

  // Gracefully fetch from Supabase
  async function fetchSupabaseData(): Promise<any | null> {
    try {
      const url = `${SUPABASE_URL}/rest/v1/tournament_store?key=eq.default&select=data`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        }
      });

      if (res.status === 200 || res.status === 206) {
        const rows = (await res.json()) as any[];
        if (rows && rows.length > 0 && rows[0].data) {
          return rows[0].data;
        }
      }
    } catch (error) {
      console.error("Supabase load failed, using local database fallback:", error);
    }
    return null;
  }

  // Gracefully save to Supabase
  async function saveSupabaseData(data: any): Promise<boolean> {
    try {
      const url = `${SUPABASE_URL}/rest/v1/tournament_store`;
      
      // Try PostgREST Upsert using key column mapping
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,on-conflict=key"
        },
        body: JSON.stringify({ key: "default", data: data })
      });

      if (res.ok) {
        console.log("Supabase tournament database successfully upserted.");
        return true;
      }

      // Fallback: If upsert failed, try direct PATCH
      console.log(`Supabase UPSERT returned ${res.status}. Falling back to direct PATCH...`);
      const patchUrl = `${SUPABASE_URL}/rest/v1/tournament_store?key=eq.default`;
      const patchRes = await fetch(patchUrl, {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ data: data })
      });

      if (patchRes.ok) {
        console.log("Supabase tournament database patched successfully.");
        return true;
      }

      // Try raw POST as insert
      console.log(`Supabase PATCH returned ${patchRes.status}. Falling back to Insert...`);
      const insertRes = await fetch(url, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ key: "default", data: data })
      });

      if (insertRes.ok) {
        console.log("Supabase tournament database standard insert succeeded.");
        return true;
      }
    } catch (error) {
      console.error("Supabase write failed, falling back to local file persistence:", error);
    }
    return false;
  }

  // Endpoint to fetch database
  app.get("/api/data", async (req, res) => {
    // 1. Attempt to fetch from Supabase first
    const supabaseData = await fetchSupabaseData();
    if (supabaseData && typeof supabaseData === "object" && Array.isArray(supabaseData.teams)) {
      // Sync local file copy
      try {
        fs.writeFileSync(dbPath, JSON.stringify(supabaseData, null, 2), "utf-8");
      } catch (err) {}
      return res.json(supabaseData);
    }

    // 2. Fall back to local db.json filesystem persistence
    if (fs.existsSync(dbPath)) {
      try {
        const localDataRaw = fs.readFileSync(dbPath, "utf-8");
        const localData = JSON.parse(localDataRaw);

        // Seed Supabase database if it has loaded empty
        if (localData && typeof localData === "object" && Array.isArray(localData.teams)) {
          console.log("Central DB is empty or uninitialized. Seeding latest local data structure...");
          await saveSupabaseData(localData);
        }

        return res.json(localData);
      } catch (e) {
        return res.status(500).json({ error: "Failed to read database" });
      }
    } else {
      // Return empty default state if no db.json exists
      return res.json({});
    }
  });

  // Endpoint to save database
  app.post("/api/data", async (req, res) => {
    try {
      // 1. Instant local failover write
      fs.writeFileSync(dbPath, JSON.stringify(req.body, null, 2), "utf-8");

      // 2. CENTRAL CLOUD WRITE TO SUPABASE
      const isCloudSynced = await saveSupabaseData(req.body);

      return res.json({ status: "ok", data: req.body, supabase_synced: isCloudSynced });
    } catch (e) {
      return res.status(500).json({ error: "Failed to write database" });
    }
  });

  // DB Connection & Status verification endpoint
  app.get("/api/db-status", async (req, res) => {
    try {
      const url = `${SUPABASE_URL}/rest/v1/tournament_store?key=eq.default&select=data`;
      const sRes = await fetch(url, {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`
        }
      });
      if (sRes.ok) {
        return res.json({
          connected: true,
          status: "Fully Connected",
          message: "Your application is writing directly to the Supabase database central node.",
          table: "tournament_store"
        });
      } else {
        const errBody = await sRes.text();
        return res.json({
          connected: false,
          status: "Schema Missing",
          message: "Securely reached Supabase endpoint, but table 'tournament_store' does not exist yet.",
          error: errBody,
          sql: "CREATE TABLE tournament_store (\n  key TEXT PRIMARY KEY,\n  data JSONB\n);"
        });
      }
    } catch (err: any) {
      return res.json({
        connected: false,
        status: "Offline",
        message: "Failed to contact database endpoint. Please verify connection credentials.",
        error: err.message
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
