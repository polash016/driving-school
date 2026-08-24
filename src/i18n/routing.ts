import { defineRouting } from "next-intl/routing";
import { schoolConfig } from "../../config/school.config";

export const routing = defineRouting({
  locales: schoolConfig.locales.supported,
  defaultLocale: schoolConfig.locales.default,
  // URL prefixes: /en and /no (locale code is nb, public path is /no)
  localePrefix: {
    mode: "always",
    prefixes: { nb: "/no" },
  },
});
