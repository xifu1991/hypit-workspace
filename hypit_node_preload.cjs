// Hypit Studio startup compatibility shim for environments where node:os
// cannot resolve the current user while spawning tsx.
const os = require("node:os");
const originalUserInfo = os.userInfo;
try {
  originalUserInfo();
} catch (_) {
  os.userInfo = () => ({ username: "admin", uid: -1, gid: -1, shell: "", homedir: "C:\\Users\\admin" });
}
