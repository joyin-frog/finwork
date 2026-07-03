import { MemorySettings } from "@/app/config/memory/memory-settings";
import { ProfileSettings } from "@/app/config/profile/profile-settings";

/** 公司画像与长期记忆共同构成小财对用户业务的了解，放在同一滚动页中。 */
export function UnderstandingSettings() {
  return (
    <div className="flex flex-col gap-8">
      <ProfileSettings />
      <MemorySettings />
    </div>
  );
}
