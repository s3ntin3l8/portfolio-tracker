// Allow side-effect imports of global stylesheets (e.g. `import "./globals.css"`).
declare module "*.css";

// CSS Modules — typed as a class-name lookup so dynamic bracket access
// (`styles[someKey]`) type-checks (used by the onboarding theme's `inputClass`).
declare module "*.module.css" {
  const classes: { readonly [className: string]: string };
  export default classes;
}
