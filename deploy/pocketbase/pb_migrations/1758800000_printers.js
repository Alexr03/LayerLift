/// <reference path="../pb_data/types.d.ts" />
// "My printers": each account's printers, their bed size and the filaments loaded in them (one
// for a single-colour printer, up to 16 with an AMS or other multi-material unit). Both tools
// read them. Only the owner can see or change their printers.

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users")
    const own = '@request.auth.id != "" && user = @request.auth.id'
    const printers = new Collection({
      type: "base",
      name: "printers",
      listRule: own,
      viewRule: own,
      createRule: '@request.auth.id != "" && @request.body.user = @request.auth.id',
      updateRule: own + " && (@request.body.user:isset = false || @request.body.user = @request.auth.id)",
      deleteRule: own,
      fields: [
        { type: "relation", name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
        { type: "text", name: "name", max: 80 },
        { type: "json", name: "data", maxSize: 65536 },
        { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_printers_user ON printers (user, created)"],
    })
    app.save(printers)
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("printers"))
  },
)
