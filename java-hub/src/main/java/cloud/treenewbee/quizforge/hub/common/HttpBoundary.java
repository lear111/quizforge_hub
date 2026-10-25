package cloud.treenewbee.quizforge.hub.common;

import java.io.IOException;
import java.util.Map;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class HttpBoundary extends OncePerRequestFilter {
    private final cloud.treenewbee.quizforge.hub.account.VerificationProvider verification;
    public HttpBoundary(cloud.treenewbee.quizforge.hub.account.VerificationProvider verification){this.verification=verification;}
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "same-origin");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Cache-Control", "no-store");
        boolean admin=request.getRequestURI().startsWith("/admin/");
        String captcha=!admin&&verification.captchaReady()?" https://challenges.cloudflare.com":"";
        response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'"+captcha+"; frame-src 'self'"+captcha+"; style-src 'self'; img-src 'self' blob:; connect-src 'self'"+captcha+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        chain.doFilter(request, response);
    }
    @RestControllerAdvice
    public static class Errors {
        @ExceptionHandler(org.springframework.web.multipart.MaxUploadSizeExceededException.class)
        public ResponseEntity<?> oversized() { return ResponseEntity.status(413).body(Map.of("error", "上传文件过大；题库最多 20 MB，每张截图最多 3 MB")); }
        @ExceptionHandler(org.springframework.web.multipart.MultipartException.class)
        public ResponseEntity<?> multipart() { return ResponseEntity.badRequest().body(Map.of("error", "上传表单无效或未完整传输，请重新选择文件")); }
        @ExceptionHandler(org.springframework.web.servlet.resource.NoResourceFoundException.class)
        public ResponseEntity<?> missing() { return ResponseEntity.status(404).body(Map.of("error", "页面不存在")); }
        @ExceptionHandler(org.springframework.web.HttpRequestMethodNotSupportedException.class)
        public ResponseEntity<?> method() { return ResponseEntity.status(405).body(Map.of("error", "此接口不支持该操作")); }
        @ExceptionHandler(HubException.class) public ResponseEntity<?> known(HubException error) {
            return ResponseEntity.status(error.status()).body(Map.of("error", error.getMessage()));
        }
        @ExceptionHandler(Exception.class) public ResponseEntity<?> unexpected(Exception error) {
            LoggerFactory.getLogger(Errors.class).error("Hub request failed ({})", error.getClass().getSimpleName());
            return ResponseEntity.internalServerError().body(Map.of("error", "服务暂时不可用，请稍后重试"));
        }
    }
}
