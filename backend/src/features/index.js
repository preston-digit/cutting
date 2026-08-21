// Feature registry. Each feature exports { basePath, router }. To add a Digit
// module, create a folder under features/ with its routes + digitOps + a
// migration in db/migrations/, then list it here.
import { cutting } from "./cutting/routes.js";

export const features = [cutting];
