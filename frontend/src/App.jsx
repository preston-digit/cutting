import { Shell } from "./core/Shell.jsx";
import "./features/index.js"; // registers all feature views

// The home view name. Change this to whichever feature view your app opens to.
const HOME_VIEW = "cutting.queue";

export default function App() {
  return <Shell home={HOME_VIEW} />;
}
