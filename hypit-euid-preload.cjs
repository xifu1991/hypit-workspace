if (typeof process.geteuid !== "function") {
  Object.defineProperty(process, "geteuid", { value: () => 0 });
}
