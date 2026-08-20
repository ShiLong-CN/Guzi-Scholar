import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.imageio.ImageIO;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;

public final class MyScholarPdfRenderer {
    private MyScholarPdfRenderer() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 4) {
            throw new IllegalArgumentException("expected input.pdf output-dir dpi page-count");
        }
        Path input = Path.of(args[0]).toAbsolutePath().normalize();
        Path output = Path.of(args[1]).toAbsolutePath().normalize();
        int dpi = Integer.parseInt(args[2]);
        int requestedPages = Integer.parseInt(args[3]);
        if (!Files.isRegularFile(input) || dpi < 36 || dpi > 600 || requestedPages < 1) {
            throw new IllegalArgumentException("invalid PDF render request");
        }
        Files.createDirectories(output);
        try (PDDocument document = Loader.loadPDF(input.toFile())) {
            if (document.getNumberOfPages() < requestedPages) {
                throw new IllegalArgumentException("PDF has fewer pages than requested");
            }
            PDFRenderer renderer = new PDFRenderer(document);
            for (int index = 0; index < requestedPages; index += 1) {
                BufferedImage image = renderer.renderImageWithDPI(index, dpi, ImageType.RGB);
                Path target = output.resolve(String.format("page-%03d.png", index + 1));
                if (!ImageIO.write(image, "png", target.toFile())) {
                    throw new IllegalStateException("PNG writer is unavailable");
                }
            }
        }
    }
}
