var gulp = require('gulp');
var uglify = require('gulp-uglify');
var rename = require('gulp-rename');

gulp.task('build', function() {
    return gulp.src('e2.js')
        .pipe(uglify())
        .pipe(rename(function(file) {
            file.basename = 'e2.min';
        }))
        .pipe(gulp.dest('.'));
});
