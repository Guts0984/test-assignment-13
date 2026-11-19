FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
# Bucket names are the defaults from .env.example (photos-public / photos-private).
COPY default.conf /etc/nginx/conf.d/default.conf
