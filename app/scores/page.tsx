import type { Metadata } from "next";
import ScoresClient from "./ScoresClient";

export const metadata: Metadata = {
  title: "公开谱库 · ScoreFollow",
  description: "老师推送的校正谱面：打开即练，链接可带速度与拍号参数分享。",
};

export default function ScoresPage() {
  return <ScoresClient />;
}
