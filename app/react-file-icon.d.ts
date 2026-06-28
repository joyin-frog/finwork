// react-file-icon 不带 TS 类型,补一个最小 ambient 声明。
declare module "react-file-icon" {
  import type { FC } from "react";
  export interface FileIconProps {
    extension?: string;
    type?:
      | "image" | "acrobat" | "binary" | "code" | "compressed" | "document"
      | "drive" | "font" | "presentation" | "settings" | "spreadsheet"
      | "vector" | "video" | "audio" | "3d";
    color?: string;
    labelColor?: string;
    labelTextColor?: string;
    labelUppercase?: boolean;
    glyphColor?: string;
    foldColor?: string;
    gradientColor?: string;
    gradientOpacity?: number;
    radius?: number;
    fold?: boolean;
  }
  export const FileIcon: FC<FileIconProps>;
  export const defaultStyles: Record<string, FileIconProps>;
}
