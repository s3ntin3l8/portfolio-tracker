import type { FastifyInstance } from "fastify";
import { users } from "../db/schema.js";

interface CreateUserBody {
  name: string;
  email: string;
  notes?: string;
}

const createUserSchema = {
  body: {
    type: "object",
    required: ["name", "email"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      email: { type: "string", format: "email" },
      notes: { type: "string" },
    },
  },
};

export async function usersRoute(app: FastifyInstance) {
  // List users, decrypting the at-rest `notes` field before returning it.
  app.get("/users", async () => {
    const rows = app.db.select().from(users).all();
    return rows.map((row) => ({
      ...row,
      notes: row.notes ? app.encryption.decryptString(row.notes) : null,
    }));
  });

  // Create a user, encrypting `notes` at rest when a key is configured.
  app.post<{ Body: CreateUserBody }>(
    "/users",
    { schema: createUserSchema },
    async (request, reply) => {
      const { name, email, notes } = request.body;

      const [created] = app.db
        .insert(users)
        .values({
          name,
          email,
          notes: notes ? app.encryption.encryptString(notes) : null,
        })
        .returning()
        .all();

      reply.code(201);
      return {
        ...created,
        notes: created.notes ? app.encryption.decryptString(created.notes) : null,
      };
    },
  );
}
