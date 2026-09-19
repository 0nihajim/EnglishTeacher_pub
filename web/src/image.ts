/**
 * 選んだ画像をサーバーへ送れる形にする(話し直し)。
 *
 * 写真は数 MB あるので、ブラウザで長辺 1280px 以下に縮めてから base64 にする。
 * Gemini は 768px のタイルで見るので、これ以上の解像度は費用にしかならない。
 * スクリーンショット(PNG)は文字がにじまないよう PNG のまま、写真は JPEG にする。
 * 縮めた結果は板(retell_board)にも使うので、data URL も返す。
 *
 * 向きは createImageBitmap の imageOrientation で EXIF に従う(スマホの写真が横倒しに
 * ならない)。使えないブラウザでは <img> で読む。
 */

export interface PickedImage {
  mimeType: "image/jpeg" | "image/png";
  /** base64(data URL の頭は付かない)。 */
  data: string;
  /** 板に載せるための data URL。 */
  dataUrl: string;
  width: number;
  height: number;
}

export const MAX_SIDE = 1280;
/** PNG のままにしておける data URL の長さ。超えたら JPEG に落とす(約 4MB のバイト)。 */
const MAX_PNG_DATA_URL = 5_500_000;

export async function prepareImage(file: Blob): Promise<PickedImage> {
  const source = await loadBitmap(file);
  const srcW = source.width;
  const srcH = source.height;
  if (!srcW || !srcH) throw new Error("画像の大きさが分かりません");
  const scale = Math.min(1, MAX_SIDE / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("この環境では画像を縮められません");
  ctx.drawImage(source, 0, 0, width, height);
  if ("close" in source) source.close();

  let mimeType: PickedImage["mimeType"] = file.type === "image/png" ? "image/png" : "image/jpeg";
  let dataUrl = canvas.toDataURL(mimeType, 0.9);
  if (mimeType === "image/png" && dataUrl.length > MAX_PNG_DATA_URL) {
    mimeType = "image/jpeg";
    dataUrl = canvas.toDataURL(mimeType, 0.88);
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("画像を変換できませんでした");
  return { mimeType, data: dataUrl.slice(comma + 1), dataUrl, width, height };
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* 向きの指定を知らない、または形式を読めない。下で試す */
    }
    try {
      return await createImageBitmap(file);
    } catch {
      /* <img> で */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("画像を読めませんでした(JPEG か PNG にしてください)"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
