package cloud.treenewbee.quizforge.hub.storage;

import java.nio.file.Files;
import java.sql.*;
import java.util.*;
import org.springframework.stereotype.Component;
import cloud.treenewbee.quizforge.hub.config.HubProperties;

@Component
public class HubDatabase {
    private final String url;
    @FunctionalInterface public interface Work<T> { T run(Connection connection) throws SQLException; }
    public HubDatabase(HubProperties properties) throws Exception {
        var directory = properties.dataDir();
        var database = directory.resolve("hub.sqlite");
        var owner = directory.resolve("java-hub-local.json");
        var snapshot = directory.resolve("java-migration-snapshot.json");
        if (Files.exists(database) && !Files.exists(owner)) {
            if (!Files.isRegularFile(snapshot) || Files.isSymbolicLink(snapshot))
                throw new IllegalStateException("Existing Node data is protected. Prepare a separate stopped-service snapshot with scripts/snapshot-hub-for-java.mjs.");
            var record = tools.jackson.databind.json.JsonMapper.builder().build().readTree(Files.readString(snapshot));
            if (!record.path("complete").asBoolean(false) || !record.path("sourceStopped").asBoolean(false))
                throw new IllegalStateException("Incomplete migration snapshot; preserve it and create a new rehearsal copy.");
        }
        Files.createDirectories(properties.dataDir().resolve("files"));
        url = "jdbc:sqlite:" + properties.dataDir().resolve("hub.sqlite");
        migrateLegacyEmail();
        try (Connection connection = open(); var statement = connection.createStatement()) {
            statement.execute("PRAGMA journal_mode=WAL");
            for (String resource : List.of("/schema.sql","/account-schema.sql","/admin-schema.sql","/ai-schema.sql")) try (var stream = getClass().getResourceAsStream(resource)) {
                for (String sql : new String(Objects.requireNonNull(stream).readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).split(";"))
                    if (!sql.isBlank()) statement.execute(sql);
            }
            for (String table : List.of("email_codes","contact_codes"))
                if (rows(connection,"PRAGMA table_info("+table+")").stream().noneMatch(column -> column.get("name").equals("captcha_verified")))
                    statement.execute("ALTER TABLE "+table+" ADD COLUMN captcha_verified INTEGER NOT NULL DEFAULT 1");
            for(var migration:List.of(new String[]{"ai_redeem_codes","code_cipher","TEXT"},new String[]{"ai_redeem_codes","seq","INTEGER"},new String[]{"official_ai_usage","points","INTEGER NOT NULL DEFAULT 0"}))
                if(rows(connection,"PRAGMA table_info("+migration[0]+")").stream().noneMatch(column->column.get("name").equals(migration[1])))statement.execute("ALTER TABLE "+migration[0]+" ADD COLUMN "+migration[1]+" "+migration[2]);
            long seq=number(row(connection,"SELECT COALESCE(MAX(seq),0) n FROM ai_redeem_codes").get("n"));for(var code:rows(connection,"SELECT id FROM ai_redeem_codes WHERE seq IS NULL ORDER BY created,id"))update(connection,"UPDATE ai_redeem_codes SET seq=? WHERE id=?",++seq,code.get("id"));
        }
        if (!Files.exists(owner)) Files.writeString(owner, "{\"schemaVersion\":1,\"purpose\":\"java-hub-preview\"}\n", java.nio.file.StandardOpenOption.CREATE_NEW);
    }
    private void migrateLegacyEmail() throws SQLException {
        try (var connection=open();var statement=connection.createStatement()) {
            var columns=rows(connection,"PRAGMA table_info(users)");
            if(columns.stream().noneMatch(column -> column.get("name").equals("email") && number(column.get("notnull"))!=0)) return;
            if(!columns.stream().map(column -> column.get("name")).toList().equals(List.of("id","email","name","password","admin","created")))
                throw new IllegalStateException("Unsupported legacy users schema; preserve the data for review");
            var extras=rows(connection,"SELECT sql FROM sqlite_master WHERE tbl_name='users' AND type IN ('index','trigger') AND sql IS NOT NULL");
            statement.execute("PRAGMA foreign_keys=OFF"); statement.execute("BEGIN IMMEDIATE");
            try {
                statement.execute("CREATE TABLE users_contact_migration(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL)");
                statement.execute("INSERT INTO users_contact_migration SELECT id,email,name,password,admin,created FROM users");
                statement.execute("DROP TABLE users"); statement.execute("ALTER TABLE users_contact_migration RENAME TO users");
                for(var extra:extras) statement.execute((String)extra.get("sql"));
                if(!rows(connection,"PRAGMA foreign_key_check").isEmpty()) throw new SQLException("Contact migration foreign key check failed");
                statement.execute("COMMIT");
            } catch(Exception error) { statement.execute("ROLLBACK");throw error; }
            finally { statement.execute("PRAGMA foreign_keys=ON"); }
        }
    }
    private Connection open() throws SQLException {
        Connection connection = DriverManager.getConnection(url);
        try (var statement = connection.createStatement()) {
            statement.execute("PRAGMA foreign_keys=ON"); statement.execute("PRAGMA busy_timeout=5000");
        }
        return connection;
    }
    public <T> T read(Work<T> work) { try (var connection = open()) { return work.run(connection); } catch (SQLException error) { throw new IllegalStateException("Database operation failed", error); } }
    public <T> T transaction(Work<T> work) {
        return read(connection -> {
            try (var statement = connection.createStatement()) {
                statement.execute("BEGIN IMMEDIATE");
                try { T value = work.run(connection); statement.execute("COMMIT"); return value; }
                catch (Exception error) { try { statement.execute("ROLLBACK"); } catch (SQLException rollback) { error.addSuppressed(rollback); } throw error; }
            }
        });
    }
    public static List<Map<String,Object>> rows(Connection connection, String sql, Object... args) throws SQLException {
        try (var statement = connection.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) statement.setObject(i + 1, args[i]);
            try (var result = statement.executeQuery()) {
                var rows = new ArrayList<Map<String,Object>>(); var meta = result.getMetaData();
                while (result.next()) { var row = new LinkedHashMap<String,Object>(); for (int i = 1; i <= meta.getColumnCount(); i++) row.put(meta.getColumnLabel(i), result.getObject(i)); rows.add(row); }
                return rows;
            }
        }
    }
    public static Map<String,Object> row(Connection c, String sql, Object... args) throws SQLException { var rows = rows(c, sql, args); return rows.isEmpty() ? null : rows.getFirst(); }
    public static int update(Connection connection, String sql, Object... args) throws SQLException {
        try (var statement = connection.prepareStatement(sql)) { for (int i = 0; i < args.length; i++) statement.setObject(i + 1, args[i]); return statement.executeUpdate(); }
    }
    public static long number(Object value) { return ((Number)value).longValue(); }
}
