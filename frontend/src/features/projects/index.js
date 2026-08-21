// PROJECTS feature registration (EXAMPLE — delete with the feature).
// Importing this module registers its views with the core registry.
import { registerView } from "../../core/registry.js";
import ProjectList from "./ProjectList.jsx";
import ProjectDetail from "./ProjectDetail.jsx";

registerView("projects.list", ProjectList);
registerView("projects.detail", ProjectDetail);
