import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const token = jwt.sign(
  {
    userId: "king",
    role: "super_admin",
    namespace: "core",
  },
  process.env.JWT_SECRET,
  { expiresIn: "7d" }
);

console.log("\n🔥 YOUR TOKEN:\n");
console.log(token);
