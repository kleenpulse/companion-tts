import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-mono/400.css";
import "../styles/globals.css";
import { PanelShell } from "./PanelShell";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PanelShell />
  </React.StrictMode>
);
