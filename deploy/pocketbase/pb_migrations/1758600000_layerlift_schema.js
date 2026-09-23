/// <reference path="../pb_data/types.d.ts" />
// LayerLift schema: tiers (per-account limits), users.tier / users.role, and jobs
// (live analysis/build records, with the finished files for accounts whose tier keeps them).

const MB = 1024 * 1024

migrate(
  (app) => {
    const settings = app.settings()
    settings.meta.appName = "LayerLift"
    // LayerLift proxies /pb to PocketBase and passes the visitor's address along.
    settings.trustedProxy.headers = ["X-Forwarded-For"]
    // PocketBase's own limiter (auth, sign-up, ...) with its default rules.
    settings.rateLimits.enabled = true
    app.save(settings)

    const tiers = new Collection({
      type: "base",
      name: "tiers",
      // Anyone may read the limits (the app shows them); only superusers change them.
      listRule: "",
      viewRule: "",
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "text", name: "name", required: true, max: 40, pattern: "^[a-z0-9_-]+$" },
        { type: "text", name: "label", max: 60 },
        { type: "text", name: "description", max: 300 },
        { type: "number", name: "sort", onlyInt: true },
        { type: "number", name: "rate_limit_per_minute", onlyInt: true, min: 0 },
        { type: "number", name: "max_jobs", onlyInt: true, min: 1 },
        { type: "number", name: "max_upload_mb", min: 0.1 },
        { type: "number", name: "max_image_side", onlyInt: true, min: 128 },
        { type: "number", name: "job_timeout_seconds", onlyInt: true, min: 10 },
        { type: "number", name: "retention_hours", onlyInt: true, min: 0 },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_tiers_name ON tiers (name)"],
    })
    app.save(tiers)

    // "anonymous" applies to visitors without an account, "free" to accounts without a tier.
    const seed = [
      {
        name: "anonymous", label: "Guest", sort: 0,
        description: "Without an account.",
        rate_limit_per_minute: 12, max_jobs: 2, max_upload_mb: 10, max_image_side: 1024,
        job_timeout_seconds: 180, retention_hours: 0,
      },
      {
        name: "free", label: "Free account", sort: 1,
        description: "Higher limits, and your builds are kept for 7 days.",
        rate_limit_per_minute: 30, max_jobs: 3, max_upload_mb: 20, max_image_side: 1536,
        job_timeout_seconds: 300, retention_hours: 168,
      },
      {
        name: "supporter", label: "Supporter", sort: 2,
        description: "The highest limits, and builds kept for 30 days.",
        rate_limit_per_minute: 60, max_jobs: 4, max_upload_mb: 30, max_image_side: 2048,
        job_timeout_seconds: 600, retention_hours: 720,
      },
    ]
    for (const data of seed) {
      const record = new Record(tiers)
      record.load(data)
      app.save(record)
    }

    const users = app.findCollectionByNameOrId("users")
    users.fields.add(new RelationField({ name: "tier", collectionId: tiers.id, maxSelect: 1 }))
    users.fields.add(new SelectField({ name: "role", values: ["user", "admin"], maxSelect: 1 }))
    // Nobody can give themselves a tier or a role: only superusers (the dashboard) set them.
    users.listRule = 'id = @request.auth.id || @request.auth.role = "admin"'
    users.viewRule = 'id = @request.auth.id || @request.auth.role = "admin"'
    users.createRule = "@request.body.tier:isset = false && @request.body.role:isset = false"
    users.updateRule = "id = @request.auth.id && @request.body.tier:isset = false && @request.body.role:isset = false"
    app.save(users)

    const own = '@request.auth.id != "" && (user = @request.auth.id || @request.auth.role = "admin")'
    const file = (name) => ({ type: "file", name, maxSelect: 1, maxSize: 200 * MB, protected: true })
    const jobs = new Collection({
      type: "base",
      name: "jobs",
      // Written by LayerLift (as a superuser). Owners and admins can read; owners can delete.
      listRule: own,
      viewRule: own,
      createRule: null,
      updateRule: null,
      deleteRule: '@request.auth.id != "" && user = @request.auth.id',
      fields: [
        { type: "select", name: "kind", required: true, values: ["analyse", "build"], maxSelect: 1 },
        { type: "relation", name: "user", collectionId: users.id, maxSelect: 1, cascadeDelete: true },
        // The visitor's IP, for abuse handling. Hidden: only superusers see it.
        { type: "text", name: "client", max: 100, hidden: true },
        { type: "select", name: "state", required: true, values: ["queued", "running", "done", "error", "cancelled"], maxSelect: 1 },
        { type: "text", name: "stage", max: 200 },
        { type: "number", name: "progress", min: 0, max: 1 },
        { type: "text", name: "title", max: 200 },
        { type: "text", name: "error", max: 1000 },
        { type: "number", name: "elapsed_s", min: 0 },
        { type: "json", name: "result", maxSize: 2 * MB },
        file("preview"),
        file("glb"),
        file("model_3mf"),
        file("stl_zip"),
        // The record (and its files) is deleted after this.
        { type: "date", name: "expires" },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_jobs_user ON jobs (user, created)",
        "CREATE INDEX idx_jobs_state ON jobs (state)",
        "CREATE INDEX idx_jobs_expires ON jobs (expires)",
      ],
    })
    app.save(jobs)
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("jobs"))
    const users = app.findCollectionByNameOrId("users")
    users.fields.removeByName("tier")
    users.fields.removeByName("role")
    users.listRule = "id = @request.auth.id"
    users.viewRule = "id = @request.auth.id"
    users.createRule = ""
    users.updateRule = "id = @request.auth.id"
    app.save(users)
    app.delete(app.findCollectionByNameOrId("tiers"))
  },
)
