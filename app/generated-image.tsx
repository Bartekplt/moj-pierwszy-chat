import type { GeneratedImage } from "../lib/images";

export default function GeneratedImageView({ image, id }: { image: GeneratedImage; id: string }) {
  const extension = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType === "image/webp" ? "webp" : "png";
  return <div className="image-result">
    <img className="generated-image" src={image.url} alt="Obraz wygenerowany na podstawie opisu" />
    <a className="download-image" href={image.url} download={`studio-nova-${id}.${extension}`}>Pobierz</a>
    <small className="model-caption">Model: {image.modelId || "API nie podało identyfikatora modelu"}</small>
  </div>;
}
