import { HasEqual } from "../utils/types";

export {};
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeEqualByMethodTo<T extends HasEqual<T>>(other: T): R;
    }
  }
}
