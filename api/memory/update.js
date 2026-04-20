// cortex-server/api/memory/update.js

import express from "express";
import { updateMemory } from "../../backend/memory/memory.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const body = req.body;

    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid memory payload" });
    }

    await updateMemory(body);

    res.json({
      success: true,
      message: "Memory updated successfully",
      updated: body,
    });
  } catch (err) {
    console.error("Memory update error:", err);
    res.status(500).json({ error: "Failed to update memory" });
  }
});

export default router;

