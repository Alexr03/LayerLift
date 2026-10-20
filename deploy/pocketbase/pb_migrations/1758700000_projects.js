/// <reference path="../pb_data/types.d.ts" />
// Saved projects (the Gridfinity tool's drawers and bins). A project is its settings as JSON, and
// meshes are rebuilt in the browser, so there is no per-account cap: each record is small.
// Only the owner can see or change their projects; nobody can create one for someone else.

const MB = 1024 * 1024

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users")
    const own = '@request.auth.id != "" && user = @request.auth.id'
    const projects = new Collection({
      type: "base",
      name: "projects",
      listRule: own,
      viewRule: own,
      createRule: '@request.auth.id != "" && @request.body.user = @request.auth.id',
      updateRule: own + " && (@request.body.user:isset = false || @request.body.user = @request.auth.id)",
      deleteRule: own,
      fields: [
        { type: "relation", name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
        { type: "select", name: "tool", required: true, values: ["gridfinity"], maxSelect: 1 },
        { type: "text", name: "title", max: 200 },
        { type: "json", name: "data", maxSize: 2 * MB },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_projects_user ON projects (user, tool, updated)"],
    })
    app.save(projects)
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("projects"))
  },
)
