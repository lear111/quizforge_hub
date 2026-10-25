package cloud.treenewbee.quizforge.hub.maintenance;

import java.nio.file.*;
import java.util.*;
import org.springframework.boot.*;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.HubApplication;

/** Local operator command. Starts neither an HTTP server nor scheduled mail delivery. */
public final class HubAdminCli {
    public static void main(String[] args){System.exit(run(args));}
    static int run(String[] args){
        var operands=new ArrayList<String>();String directory=System.getenv("HUB_JAVA_DATA_DIR");
        if(directory==null||directory.isBlank())directory=System.getenv("DATA_DIR");
        for(String arg:args){if(arg.startsWith("--data-dir="))directory=arg.substring(11);else if(arg.startsWith("--")){System.err.println("Only --data-dir=<existing Java data directory> is supported.");return 2;}else operands.add(arg);}
        if(operands.isEmpty()||!HubMaintenance.validArguments(operands)){System.err.println("Usage: admin <promote|demote|invite-create|invite-list|invite-revoke|auth-login-recovery|signup-bonus|download-publish|download-remove> ... --data-dir=<directory>");return 2;}
        try{
            if(directory==null||directory.isBlank())throw new IllegalArgumentException("Specify --data-dir, HUB_JAVA_DATA_DIR or DATA_DIR explicitly.");
            Path root=Path.of(directory).toAbsolutePath().normalize();
            if(Files.isSymbolicLink(root)||!Files.isRegularFile(root.resolve("hub.sqlite"),LinkOption.NOFOLLOW_LINKS))throw new IllegalArgumentException("Use an existing Java-owned database or a prepared migration copy.");
            if(!Files.isRegularFile(root.resolve("java-hub-local.json"),LinkOption.NOFOLLOW_LINKS)&&!Files.isRegularFile(root.resolve("java-migration-snapshot.json"),LinkOption.NOFOLLOW_LINKS))throw new IllegalArgumentException("Unmarked Node data is protected; prepare a separate migration copy first.");
            var app=new SpringApplication(HubApplication.class);app.setWebApplicationType(WebApplicationType.NONE);app.setLogStartupInfo(false);
            try(var context=app.run("--hub.data-dir="+root,"--hub.maintenance=true","--spring.main.web-application-type=none","--spring.main.banner-mode=off","--logging.level.root=OFF")){
                Object result=context.getBean(HubMaintenance.class).execute(operands);
                System.out.println(JsonMapper.builder().build().writeValueAsString(result));
            }
            return 0;
        }catch(IllegalArgumentException|cloud.treenewbee.quizforge.hub.common.HubException error){System.err.println(error.getMessage());return 1;}
        catch(Exception error){System.err.println("Maintenance failed; preserve the data and check the command and Java configuration.");return 1;}
    }
}
