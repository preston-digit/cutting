// CUTTING feature registration. Importing this module registers its views
// with the core registry.
import { registerView } from "../../core/registry.js";
import CuttingQueue from "./CuttingQueue.jsx";

registerView("cutting.queue", CuttingQueue);
