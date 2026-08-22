import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;

public final class MyScholarPdfRenderer {
    private MyScholarPdfRenderer() {}

    public static void main(String[] args) throws Exception {
        if (args.length == 4) {
            renderPages(args);
            return;
        }
        if (args.length == 3 && "--crop".equals(args[0])) {
            renderCrops(Path.of(args[1]), Path.of(args[2]));
            return;
        }
        throw new IllegalArgumentException(
            "expected input.pdf output-dir dpi page-count or --crop input.pdf crop-manifest.tsv"
        );
    }

    private static void renderPages(String[] args) throws Exception {
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

    private static final class CropRequest {
        private final int page;
        private final double left;
        private final double top;
        private final double right;
        private final double bottom;
        private final int dpi;
        private final Path output;

        private CropRequest(int page, double left, double top, double right, double bottom, int dpi, Path output) {
            this.page = page;
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
            this.dpi = dpi;
            this.output = output;
        }
    }

    private static void renderCrops(Path input, Path manifest) throws Exception {
        input = input.toAbsolutePath().normalize();
        manifest = manifest.toAbsolutePath().normalize();
        if (!Files.isRegularFile(input) || !Files.isRegularFile(manifest)) {
            throw new IllegalArgumentException("invalid PDF or crop manifest");
        }
        Map<String, List<CropRequest>> requestsByRender = new LinkedHashMap<>();
        try (BufferedReader reader = Files.newBufferedReader(manifest)) {
            String line;
            int lineNumber = 0;
            while ((line = reader.readLine()) != null) {
                lineNumber += 1;
                if (line.isBlank()) {
                    continue;
                }
                String[] fields = line.split("\\t", -1);
                if (fields.length != 7) {
                    throw new IllegalArgumentException("invalid crop manifest line " + lineNumber);
                }
                int page = Integer.parseInt(fields[0]);
                double left = Double.parseDouble(fields[1]);
                double top = Double.parseDouble(fields[2]);
                double right = Double.parseDouble(fields[3]);
                double bottom = Double.parseDouble(fields[4]);
                int dpi = Integer.parseInt(fields[5]);
                Path output = Path.of(fields[6]).toAbsolutePath().normalize();
                if (page < 1 || dpi < 36 || dpi > 600
                    || !Double.isFinite(left) || !Double.isFinite(top)
                    || !Double.isFinite(right) || !Double.isFinite(bottom)
                    || left < 0.0 || top < 0.0 || right > 1.0 || bottom > 1.0
                    || right <= left || bottom <= top) {
                    throw new IllegalArgumentException("invalid crop manifest line " + lineNumber);
                }
                CropRequest request = new CropRequest(page, left, top, right, bottom, dpi, output);
                String key = page + "@" + dpi;
                requestsByRender.computeIfAbsent(key, ignored -> new ArrayList<>()).add(request);
            }
        }
        if (requestsByRender.isEmpty()) {
            return;
        }
        try (PDDocument document = Loader.loadPDF(input.toFile())) {
            PDFRenderer renderer = new PDFRenderer(document);
            for (List<CropRequest> requests : requestsByRender.values()) {
                CropRequest first = requests.get(0);
                if (first.page > document.getNumberOfPages()) {
                    throw new IllegalArgumentException("crop page is outside the PDF");
                }
                BufferedImage pageImage = renderer.renderImageWithDPI(first.page - 1, first.dpi, ImageType.RGB);
                for (CropRequest request : requests) {
                    int left = clampPixel((int) Math.round(request.left * pageImage.getWidth()), pageImage.getWidth());
                    int top = clampPixel((int) Math.round(request.top * pageImage.getHeight()), pageImage.getHeight());
                    int right = clampPixel((int) Math.round(request.right * pageImage.getWidth()), pageImage.getWidth());
                    int bottom = clampPixel((int) Math.round(request.bottom * pageImage.getHeight()), pageImage.getHeight());
                    if (right <= left || bottom <= top) {
                        throw new IllegalArgumentException("crop region is empty");
                    }
                    Files.createDirectories(request.output.getParent());
                    BufferedImage crop = pageImage.getSubimage(left, top, right - left, bottom - top);
                    if (!ImageIO.write(crop, "png", request.output.toFile())) {
                        throw new IOException("PNG writer is unavailable");
                    }
                }
            }
        }
    }

    private static int clampPixel(int value, int limit) {
        return Math.max(0, Math.min(limit, value));
    }
}
