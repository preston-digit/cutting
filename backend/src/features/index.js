// Feature registry. Each feature exports { basePath, router }. To add a Digit
// module, create a folder under features/ with its routes + digitOps + a
// migration in db/migrations/, then list it here.
import { projects } from "./projects/routes.js";

export const features = [
  projects, // EXAMPLE — remove this line (and the projects/ folder + migration) for a clean app.
];
