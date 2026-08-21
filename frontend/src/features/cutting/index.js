// CUTTING feature registration. Importing this module registers its views
// with the core registry.
import { registerView } from "../../core/registry.js";
import CuttingQueue from "./CuttingQueue.jsx";
import CutScreen from "./CutScreen.jsx";

registerView("cutting.queue", CuttingQueue);
registerView("cutting.cut", CutScreen);
