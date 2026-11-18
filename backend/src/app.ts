import express from "express";

const app = express();

// Parse incoming JSON request bodies.
app.use(express.json());

// Basic backend health endpoint.
app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    service: "bitt-backend",
    status: "UP"
  });
});

export default app;
