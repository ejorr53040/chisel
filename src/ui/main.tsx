import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./brand/tokens.css";
import "./brand/components.css";
import "./app.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
);
