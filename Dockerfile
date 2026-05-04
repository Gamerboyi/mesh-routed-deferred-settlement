# ---- Stage 1: Build ----
# Uses Maven to compile the Java code into a runnable JAR file
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
COPY src ./src
COPY .mvn ./.mvn
COPY mvnw .
RUN mvn clean package -DskipTests

# ---- Stage 2: Run ----
# Uses a slim JDK image to actually run the app (much smaller than the build image)
FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar

# Render sets the PORT environment variable — Spring Boot reads it automatically
ENV PORT=8081
EXPOSE 8081

ENTRYPOINT ["java", "-jar", "app.jar"]
